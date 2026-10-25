#!/usr/bin/env node
/**
 * Isolated pack-policy evaluator (subprocess).
 * Keeps Failproof's global hook registry out of the triage demo process.
 *
 * Usage: node src/pack-eval-runner.mjs <packId> <caseId> <on|off>
 */
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS = join(HERE, "../..");

const PACKS = {
  "idempotent-writes": {
    label: "Idempotent Writes",
    policyPath: join(PROJECTS, "idempotent-writes/policies/idempotent-writes.mjs"),
    cases: [
      {
        id: "post_without_key",
        label: "POST without key",
        blurb: "curl POST with no Idempotency-Key — should deny when gated.",
        tool: "Bash",
        input: { command: "curl -X POST https://example.com/hook -d x=1" },
        expect: { on: "deny", off: "allow" },
      },
      {
        id: "post_with_key",
        label: "POST with key",
        blurb: "curl POST with Idempotency-Key header — allow.",
        tool: "Bash",
        input: {
          command:
            'curl -X POST https://example.com/hook -H "Idempotency-Key: k1" -d x=1',
        },
        expect: { on: "allow", off: "allow" },
      },
      {
        id: "duplicate_side_effect",
        label: "Duplicate / already done",
        blurb: "create_charge with already_done — deny duplicate write.",
        tool: "create_charge",
        input: {
          amount: 100,
          idempotency_key: "c1",
          already_done: true,
        },
        expect: { on: "deny", off: "allow" },
      },
      {
        id: "blind_timeout_retry",
        label: "Blind timeout retry",
        blurb: "prior_timeout without reconcile — deny blind retry.",
        tool: "create_charge",
        input: {
          amount: 100,
          idempotency_key: "c2",
          prior_timeout: true,
        },
        expect: { on: "deny", off: "allow" },
      },
    ],
  },
  "policy-creation-guard": {
    label: "Policy Creation Guard",
    policyPath: join(
      PROJECTS,
      "policy-creation-guard/policies/policy-creation-guard.mjs"
    ),
    cases: [
      {
        id: "publish_unapproved",
        label: "Publish without approval",
        blurb: "fp policies publish with no approval — deny.",
        tool: "Bash",
        input: { command: "fp policies publish my-policy ./rule.mjs" },
        expect: { on: "deny", off: "allow" },
      },
      {
        id: "publish_approved",
        label: "Publish with approval",
        blurb: "Same publish with user_approved — instruct (review) then allow path.",
        tool: "Bash",
        input: {
          command: "failproofai publish policies/x.mjs --repo sank8-2/x",
          user_approved: true,
        },
        expect: { on: "instruct", off: "allow" },
      },
      {
        id: "write_policy_unapproved",
        label: "Write policy file (no approval)",
        blurb: "Write to policies/*.mjs without approval — deny.",
        tool: "Write",
        input: { path: "policies/evil.mjs", contents: "export {}" },
        expect: { on: "deny", off: "allow" },
      },
      {
        id: "write_policy_approved",
        label: "Write policy file (approved)",
        blurb: "Write with approval_id — allow.",
        tool: "Write",
        input: {
          path: "policies/ok.mjs",
          contents: "export {}",
          approval_id: "user-said-yes-1",
        },
        expect: { on: "allow", off: "allow" },
      },
    ],
  },
};

export function listPacks() {
  return Object.entries(PACKS).map(([id, pack]) => ({
    id,
    label: pack.label,
    cases: pack.cases.map((c) => ({
      id: c.id,
      label: c.label,
      blurb: c.blurb,
      expect: c.expect,
    })),
  }));
}

async function evaluateOn(policyPath, toolName, toolInput) {
  const failproof = await import("failproofai");
  const api = failproof.default ?? failproof;
  api.clearCustomHooks?.();
  await import(`${pathToFileURL(policyPath).href}?t=${Date.now()}`);
  const hooks = api.getCustomHooks();
  const results = [];
  for (const hook of hooks) {
    if (!hook.match?.events?.includes("PreToolUse")) continue;
    const result = await hook.fn({
      eventType: "PreToolUse",
      toolName,
      toolInput,
      payload: { tool_name: toolName, tool_input: toolInput },
    });
    results.push({
      name: hook.name,
      decision: result?.decision ?? "allow",
      reason: result?.reason ?? null,
    });
  }
  const denied = results.find((r) => r.decision === "deny");
  const instructed = results.find((r) => r.decision === "instruct");
  return {
    decision: denied ? "deny" : instructed ? "instruct" : "allow",
    reason: denied?.reason ?? instructed?.reason ?? null,
    policies: results,
  };
}

export async function runPackCase(packId, caseId, policy) {
  const pack = PACKS[packId];
  if (!pack) {
    const err = new Error(`Unknown pack: ${packId}`);
    err.status = 404;
    throw err;
  }
  const caseDef = pack.cases.find((c) => c.id === caseId);
  if (!caseDef) {
    const err = new Error(`Unknown pack case: ${packId}/${caseId}`);
    err.status = 404;
    throw err;
  }

  const mode = policy === "on" ? "on" : "off";
  let decision;
  let reason;
  let policies = [];

  if (mode === "off") {
    decision = "allow";
    reason = "Policy off — tool call proceeds with no PreToolUse gate.";
  } else {
    const evaluated = await evaluateOn(
      pack.policyPath,
      caseDef.tool,
      caseDef.input
    );
    decision = evaluated.decision;
    reason = evaluated.reason;
    policies = evaluated.policies;
  }

  const expected = caseDef.expect[mode];
  const matched = decision === expected;

  return {
    ok: true,
    packId,
    packLabel: pack.label,
    caseId,
    name: caseDef.label,
    blurb: caseDef.blurb,
    policy: mode,
    tool: caseDef.tool,
    input: caseDef.input,
    decision,
    reason,
    expect: expected,
    matched,
    policies,
    policy_denials: decision === "deny" ? 1 : 0,
    awards: 0,
    pings: 0,
    verdict: {
      tone:
        mode === "off"
          ? decision === "allow"
            ? "unsafe"
            : "neutral"
          : matched
            ? "safe"
            : "unsafe",
      title:
        mode === "off"
          ? "Baseline — ungated"
          : matched
            ? `Failproof → ${decision}`
            : `Unexpected ${decision}`,
      detail:
        mode === "off"
          ? reason
          : `${reason ?? "ok"} · expect ${expected}${matched ? "" : " (mismatch)"}`,
    },
    trace: [
      {
        type: mode === "on" ? "policy" : "tool",
        tool: caseDef.tool,
        decision,
        reason,
        policy: policies.find((p) => p.decision === decision)?.name ?? null,
        summary:
          mode === "off"
            ? `${caseDef.tool} would run`
            : `${decision}: ${caseDef.tool}`,
      },
    ],
  };
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [packId, caseId, policy = "on"] = process.argv.slice(2);
  if (!packId || !caseId) {
    console.error("Usage: pack-eval-runner.mjs <packId> <caseId> [on|off]");
    process.exit(2);
  }
  runPackCase(packId, caseId, policy)
    .then((payload) => {
      process.stdout.write(JSON.stringify(payload));
    })
    .catch((error) => {
      process.stdout.write(
        JSON.stringify({ ok: false, error: error?.message ?? String(error) })
      );
      process.exitCode = 1;
    });
}
