import { randomUUID } from "node:crypto";
import * as failproofai from "@failproofai/sdk";
import { DiscordError, GitHubError, PolicyDeniedError } from "./errors.mjs";
import { evaluatePolicy } from "./policy-gate.mjs";

const TRACE_ENABLED = process.env.FAILPROOFAI_TRACE === "1";
if (TRACE_ENABLED) {
  failproofai.configure({
    environment: process.env.FAILPROOFAI_ENV ?? "dev",
  });
}

function compareLeaderboard(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  const aMerge = a.earliest_merge ?? "9999-12-31T23:59:59Z";
  const bMerge = b.earliest_merge ?? "9999-12-31T23:59:59Z";
  if (aMerge !== bMerge) return aMerge < bMerge ? -1 : 1;
  return (a.lowest_pr ?? Number.MAX_SAFE_INTEGER) -
    (b.lowest_pr ?? Number.MAX_SAFE_INTEGER);
}

function buildLeaderboard(awards) {
  const byContributor = new Map();

  for (const award of awards) {
    const entry = byContributor.get(award.contributor) ?? {
      contributor: award.contributor,
      points: 0,
      earliest_merge: null,
      lowest_pr: Number.MAX_SAFE_INTEGER,
      prs: [],
    };
    entry.points += award.points;
    entry.prs.push(award.pr_number);
    if (
      award.merged_at &&
      (!entry.earliest_merge || award.merged_at < entry.earliest_merge)
    ) {
      entry.earliest_merge = award.merged_at;
    }
    entry.lowest_pr = Math.min(entry.lowest_pr, award.pr_number);
    byContributor.set(award.contributor, entry);
  }

  return [...byContributor.values()]
    .map((entry) => ({ ...entry, prs: [...new Set(entry.prs)] }))
    .sort(compareLeaderboard);
}

export function countDuplicateAwards(awards) {
  const counts = new Map();
  for (const award of awards) {
    counts.set(award.key, (counts.get(award.key) ?? 0) + 1);
  }
  return [...counts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0
  );
}

export function createRuntime({
  scenario,
  policyMode = "on",
  policyPath,
} = {}) {
  if (!scenario?.rules) {
    throw new Error("createRuntime needs a scenario with rules");
  }

  const githubResponses = [...(scenario.githubResponses ?? [])];
  const discordResponses = [...(scenario.discordResponses ?? [])];

  const state = {
    rules: null,
    rulesFetchedAt: null,
    lastScore: null,
    scores: {},
    awards: {},
    awardsList: [],
    leaderboard: [...(scenario.initialLeaderboard ?? [])],
    pointsCommitted: false,
    winner: null,
    winnerVerified: false,
    pings: {},
    pingsList: [],
    policyDenials: 0,
    instructions: [],
    retries: 0,
    trace: [],
    errors: [],
  };

  for (const award of scenario.initialAwards ?? []) {
    state.awards[award.key] = award;
    state.awardsList.push(award);
  }

  function resolvePr(number) {
    const key = String(number);
    if (scenario.prs?.[key]) return scenario.prs[key];
    if (scenario.pr && String(scenario.pr.number) === key) return scenario.pr;
    return null;
  }

  function enrichInput(toolName, input = {}) {
    const base = { ...input };

    if (toolName === "award_points") {
      const pr = resolvePr(base.pr_number);
      const score = state.scores[base.pr_number] ?? state.lastScore;
      const key =
        base.idempotency_key ??
        `${scenario.repo}:${base.pr_number}:${base.contributor}`;
      return {
        ...base,
        idempotency_key: key,
        rules_checked: state.rules !== null,
        rules_version: state.rules?.version ?? null,
        current_rules_version:
          scenario.currentRulesVersion ?? scenario.rules.version,
        pr_merged: pr?.merged === true,
        eligible: score?.eligible === true,
        spam: score?.spam === true,
        duplicate: score?.duplicate === true,
        self_pr: score?.self_pr === true,
        maintainer_approved: pr?.maintainer_approved === true,
        already_awarded: Boolean(state.awards[key]),
      };
    }

    if (toolName === "ping_winner") {
      const winnerId = base.winner_id ?? state.winner?.contributor ?? null;
      const periodId = base.period_id ?? scenario.rules.program.id;
      const key = base.idempotency_key ?? `${periodId}:${winnerId}`;
      return {
        ...base,
        winner_id: winnerId,
        period_id: periodId,
        idempotency_key: key,
        points_committed: state.pointsCommitted,
        winner_verified: state.winnerVerified,
        already_pinged: Boolean(state.pings[key]),
      };
    }

    if (toolName === "score_pr") {
      const pr = resolvePr(base.pr_number);
      return {
        ...base,
        rules_version: state.rules?.version ?? null,
        pr_title: pr?.title ?? "",
        pr_body: pr?.body ?? "",
      };
    }

    return base;
  }

  function emitPolicyTrace(toolName, input, policy) {
    if (!TRACE_ENABLED) return;

    for (const entry of policy.results) {
      const hookId = randomUUID().replace(/-/g, "");
      failproofai.event.hookTriggered({
        hookName: entry.name,
        hookId,
        triggerEvent: "PreToolUse",
        input: { tool: toolName, input },
      });
      failproofai.event.hookCompleted({
        hookName: entry.name,
        hookId,
        outcome:
          entry.decision === "deny"
            ? "denied"
            : entry.decision === "instruct"
              ? "instructed"
              : "success",
        output: { decision: entry.decision, reason: entry.reason },
      });
    }
  }

  async function withToolTrace(toolName, input, fn) {
    if (!TRACE_ENABLED) return fn();
    return failproofai.toolCall(toolName, { input }, fn);
  }

  const tools = {
    async fetch_repo_rules() {
      if (scenario.rulesFailure) {
        throw new Error(scenario.rulesFailure);
      }
      state.rules = scenario.rules;
      state.rulesFetchedAt = new Date().toISOString();
      return { version: state.rules.version, rules: state.rules };
    },

    async get_pull_request({ number }) {
      const response = githubResponses.shift() ?? { status: 200 };
      if (response.status !== 200) {
        throw new GitHubError(response.status, response.retry_after ?? 0);
      }
      const pr = resolvePr(number);
      if (!pr) throw new Error(`PR #${number} not found`);
      return pr;
    },

    async score_pr({ pr_number }) {
      const pr = resolvePr(pr_number);
      if (!pr) throw new Error(`PR #${pr_number} not found`);

      const rules = state.rules ?? scenario.rules;
      const key = `${scenario.repo}:${pr.number}:${pr.author}`;
      const spam = pr.labels.some((label) =>
        rules.eligibility.spam_labels.includes(label)
      );
      const duplicate = Boolean(state.awards[key]);
      const selfPr =
        rules.eligibility.excluded_users.includes(pr.author) ||
        (rules.eligibility.allow_self_pr === false &&
          pr.author === (scenario.maintainer ?? "maintainer"));
      const approved = pr.maintainer_approved === true;
      const labelOk =
        !rules.program.require_label ||
        pr.labels.includes(rules.program.label);
      const diffOk = pr.diff_lines >= rules.eligibility.min_diff_lines;
      const eligible =
        pr.merged === true &&
        labelOk &&
        diffOk &&
        !spam &&
        !duplicate &&
        !selfPr &&
        (!rules.eligibility.require_maintainer_approval || approved);

      const score = {
        pr_number: pr.number,
        contributor: pr.author,
        spam,
        duplicate,
        self_pr: selfPr,
        maintainer_approved: approved,
        label_ok: labelOk,
        diff_ok: diffOk,
        eligible,
        points: eligible ? rules.program.points_per_pr : 0,
      };
      state.scores[pr.number] = score;
      state.lastScore = score;
      return score;
    },

    async award_points(input) {
      const key = input.idempotency_key;
      if (policyMode === "on" && state.awards[key]) {
        return state.awards[key];
      }

      const pr = resolvePr(input.pr_number);
      const award = {
        key,
        pr_number: input.pr_number,
        contributor: input.contributor,
        points: input.points,
        merged_at: pr?.merged_at ?? null,
        at: new Date().toISOString(),
      };
      state.awards[key] = award;
      state.awardsList.push(award);
      return award;
    },

    async commit_leaderboard() {
      if (state.awardsList.length > 0) {
        state.leaderboard = buildLeaderboard(state.awardsList);
      }
      state.pointsCommitted = true;
      return {
        leaderboard: state.leaderboard,
        points_committed: true,
      };
    },

    async verify_winner() {
      if (state.leaderboard.length === 0) {
        state.winner = null;
        state.winnerVerified = true;
        return { winner: null };
      }
      state.winner = [...state.leaderboard].sort(compareLeaderboard)[0];
      state.winnerVerified = true;
      return { winner: state.winner };
    },

    async ping_winner(input) {
      const key = input.idempotency_key;
      if (policyMode === "on" && state.pings[key]) {
        return state.pings[key];
      }

      const response = discordResponses.shift() ?? { status: 200 };
      if (response.status !== 200) {
        throw new DiscordError(response.status, response.retry_after ?? 0);
      }

      const ping = {
        key,
        winner_id: input.winner_id,
        period_id: input.period_id,
        message_id:
          response.message_id ?? `m-${state.pingsList.length + 1}`,
        at: new Date().toISOString(),
      };
      state.pings[key] = ping;
      state.pingsList.push(ping);
      return ping;
    },

    async get_leaderboard() {
      return {
        leaderboard: state.leaderboard,
        points_committed: state.pointsCommitted,
      };
    },
  };

  async function executeTool(toolName, input = {}) {
    const enriched = enrichInput(toolName, input);

    const policy =
      policyMode === "on"
        ? await evaluatePolicy(toolName, enriched, { policyPath })
        : { decision: "allow", reason: null, results: [] };

    emitPolicyTrace(toolName, enriched, policy);

    state.trace.push({
      type: "policy",
      tool: toolName,
      input: enriched,
      decision: policy.decision,
      reason: policy.reason,
      policies: policy.results,
    });

    if (policy.decision === "deny") {
      state.policyDenials += 1;
      throw new PolicyDeniedError(policy.reason, policy.results);
    }

    if (policy.decision === "instruct" && policy.reason) {
      state.instructions.push(policy.reason);
    }

    const result = await withToolTrace(toolName, enriched, () =>
      tools[toolName](enriched)
    );
    state.trace.push({ type: "tool", tool: toolName, input: enriched, result });
    return result;
  }

  async function call(toolName, input = {}, { retries = 0, retryOn = [] } = {}) {
    let attempt = 0;

    while (true) {
      try {
        return await executeTool(toolName, input);
      } catch (error) {
        if (error instanceof PolicyDeniedError) throw error;

        const retryable = retryOn.includes(error.status);
        if (retryable && attempt < retries) {
          attempt += 1;
          state.retries += 1;
          state.trace.push({
            type: "retry",
            tool: toolName,
            attempt,
            status: error.status,
            error: error.message,
          });
          if (error.retryAfterMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, error.retryAfterMs)
            );
          }
          continue;
        }

        throw error;
      }
    }
  }

  function result() {
    return {
      status: state.errors.length > 0 ? "failed" : "ok",
      awards: state.awardsList.length,
      pings: state.pingsList.length,
      winner: state.winner?.contributor ?? null,
      duplicates: countDuplicateAwards(state.awardsList),
      policy_denials: state.policyDenials,
      instructions: state.instructions,
      retries: state.retries,
      tool_calls: state.trace.filter((entry) => entry.type === "tool").length,
      trace: state.trace,
      state,
    };
  }

  return {
    scenario,
    state,
    policyMode,
    call,
    result,
    resolvePr,
  };
}
