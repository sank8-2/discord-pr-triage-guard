import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runAgent } from "../src/agent.mjs";
import { assertExpect, buildScenario } from "../src/evals.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadCase(id) {
  const rules = JSON.parse(
    await readFile(join(ROOT, "rules/community-rules.json"), "utf8")
  );
  const cases = JSON.parse(
    await readFile(join(ROOT, "evals/cases.json"), "utf8")
  );
  const caseDef = cases.find((entry) => entry.id === id);
  assert.ok(caseDef, `missing case ${id}`);
  return { caseDef, scenario: buildScenario(caseDef, rules) };
}

async function runPair(id) {
  const { caseDef, scenario } = await loadCase(id);
  const baseline = await runAgent({
    scenario: buildScenario(caseDef, scenario.rules),
    policyMode: "off",
    planner: "naive",
  });
  const patched = await runAgent({
    scenario: buildScenario(caseDef, scenario.rules),
    policyMode: "on",
    planner: "guarded",
  });
  return { caseDef, baseline, patched };
}

test("spam: baseline awards, patched blocks", async () => {
  const { caseDef, baseline, patched } = await runPair("spam_pr_no_points");
  assert.equal(baseline.awards, 1);
  assert.equal(baseline.pings, 1);
  assert.equal(baseline.policy_denials, 0);
  assert.equal(assertExpect(patched, caseDef.expect).ok, true);
  assert.ok(patched.policy_denials >= 1);
});

test("duplicate award is idempotent when guarded", async () => {
  const { caseDef, baseline, patched } = await runPair("duplicate_award_once");
  assert.ok(baseline.awards >= 2 || baseline.duplicates >= 1);
  assert.equal(assertExpect(patched, caseDef.expect).ok, true);
});

test("GitHub 429 retries once when guarded", async () => {
  const { caseDef, baseline, patched } = await runPair(
    "github_rate_limit_retry_once"
  );
  assert.equal(baseline.awards, 0);
  assert.equal(assertExpect(patched, caseDef.expect).ok, true);
  assert.ok(patched.retries >= 1);
});

test("Discord 500 retries ping without duplicating points", async () => {
  const { caseDef, baseline, patched } = await runPair(
    "discord_ping_failure_no_duplicate_points"
  );
  assert.equal(baseline.pings, 0);
  assert.equal(assertExpect(patched, caseDef.expect).ok, true);
});

test("tie break pings bob when guarded", async () => {
  const { caseDef, baseline, patched } = await runPair(
    "tie_break_deterministic"
  );
  assert.notEqual(baseline.winner, "bob");
  assert.equal(assertExpect(patched, caseDef.expect).ok, true);
  assert.equal(patched.winner, "bob");
});
