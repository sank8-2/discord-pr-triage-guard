import { DiscordError, GitHubError, PolicyDeniedError } from "./errors.mjs";
import { createRuntime } from "./runtime.mjs";

function parseInjectedPoints(body = "") {
  const match = String(body).match(/award\s+(\d+)\s+points/i);
  return match ? Number(match[1]) : null;
}

async function ignorePolicyDenial(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PolicyDeniedError) return null;
    throw error;
  }
}

async function runNaiveTriage(runtime, prNumber) {
  const number = prNumber ?? runtime.scenario.pr?.number;
  if (number == null) throw new Error("naive triage needs a PR number");

  const pr = await runtime.call("get_pull_request", { number });
  const injected = parseInjectedPoints(pr.body);
  const points =
    injected ??
    runtime.scenario.rules?.program?.points_per_pr ??
    10;

  await runtime.call("award_points", {
    pr_number: pr.number,
    contributor: pr.author,
    points,
  });

  await runtime.call("ping_winner", {
    winner_id: pr.author,
    period_id: runtime.scenario.rules.program.id,
  });

  await runtime.call("commit_leaderboard");
  await runtime.call("verify_winner");
}

async function runGuardedTriage(runtime, prNumber) {
  const number = prNumber ?? runtime.scenario.pr?.number;
  if (number == null) throw new Error("guarded triage needs a PR number");
  const { scenario, state } = runtime;

  // Probe: award without evidence so the policy deny is visible in the trace.
  if (state.rules === null) {
    await ignorePolicyDenial(() =>
      runtime.call("award_points", {
        pr_number: number,
        contributor: "unknown",
        points: scenario.rules.program.points_per_pr,
      })
    );
  }

  await runtime.call("fetch_repo_rules");

  const pr = await runtime.call(
    "get_pull_request",
    { number },
    { retries: 1, retryOn: [429, 500] }
  );

  const score = await runtime.call("score_pr", { pr_number: pr.number });
  if (!score.eligible) return;

  const idempotencyKey = `${scenario.repo}:${pr.number}:${score.contributor}`;

  await runtime.call("award_points", {
    pr_number: pr.number,
    contributor: score.contributor,
    points: score.points,
    idempotency_key: idempotencyKey,
  });

  await ignorePolicyDenial(() =>
    runtime.call("ping_winner", {
      winner_id: score.contributor,
      period_id: scenario.rules.program.id,
    })
  );

  await runtime.call("commit_leaderboard");
  await runtime.call("verify_winner");

  const winnerId = state.winner?.contributor ?? score.contributor;
  await ignorePolicyDenial(() =>
    runtime.call(
      "ping_winner",
      {
        winner_id: winnerId,
        period_id: scenario.rules.program.id,
      },
      { retries: 1, retryOn: [500] }
    )
  );
}

async function runNaiveAnnounce(runtime) {
  const board = runtime.state.leaderboard;
  if (!board.length) return;
  const first = board[0];
  await runtime.call("ping_winner", {
    winner_id: first.contributor,
    period_id: runtime.scenario.rules.program.id,
  });
}

async function runGuardedAnnounce(runtime) {
  await runtime.call("commit_leaderboard");
  await runtime.call("verify_winner");
  const winner = runtime.state.winner;
  if (!winner) return;
  await runtime.call(
    "ping_winner",
    {
      winner_id: winner.contributor,
      period_id: runtime.scenario.rules.program.id,
    },
    { retries: 1, retryOn: [500] }
  );
}

async function runBatch(runtime, planner) {
  const deliveries = runtime.scenario.deliveries ?? [];
  const runOne =
    planner === "guarded"
      ? (n) => runGuardedTriage(runtime, n)
      : (n) => runNaiveTriage(runtime, n);

  const settled = await Promise.allSettled(deliveries.map((n) => runOne(n)));
  for (const entry of settled) {
    if (entry.status === "rejected") {
      const error = entry.reason;
      // Duplicate delivery may race into an already-pinged deny; keep going.
      if (error instanceof PolicyDeniedError) continue;
      if (error instanceof GitHubError || error instanceof DiscordError) {
        runtime.state.errors.push({
          name: error.name,
          message: error.message,
          status: error.status,
        });
        continue;
      }
      runtime.state.errors.push({
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
      });
    }
  }

  // One announcement after concurrent awards.
  if (planner === "guarded" && runtime.state.awardsList.length > 0) {
    await ignorePolicyDenial(() => runGuardedAnnounce(runtime));
  }
}

/**
 * Run the Discord PR triage agent.
 *
 * @param {object} options
 * @param {object} options.scenario fixture scenario (rules, pr, …)
 * @param {"on"|"off"} [options.policyMode]
 * @param {"naive"|"guarded"} [options.planner]
 * @param {boolean} [options.trace] unused locally; FAILPROOFAI_TRACE env drives SDK
 */
export async function runAgent({
  scenario,
  policyMode = "off",
  planner = "naive",
  trace: _trace = false,
} = {}) {
  if (!scenario) throw new Error("runAgent requires a scenario");

  const runtime = createRuntime({ scenario, policyMode });
  const kind = scenario.kind ?? "triage";

  try {
    if (kind === "announce") {
      if (planner === "guarded") await runGuardedAnnounce(runtime);
      else await runNaiveAnnounce(runtime);
    } else if (kind === "batch") {
      await runBatch(runtime, planner);
    } else if (planner === "guarded") {
      await runGuardedTriage(runtime);
    } else {
      await runNaiveTriage(runtime);
    }
  } catch (error) {
    if (
      error instanceof PolicyDeniedError ||
      error instanceof GitHubError ||
      error instanceof DiscordError
    ) {
      runtime.state.errors.push({
        name: error.name,
        message: error.message,
        status: error.status,
      });
    } else {
      runtime.state.errors.push({
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
      });
    }
  }

  return runtime.result();
}
