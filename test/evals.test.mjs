import assert from "node:assert/strict";
import test from "node:test";
import { printEvalTable, runEvals } from "../src/evals.mjs";

test("all 10 eval cases are accepted", async () => {
  const payload = await runEvals({ runs: 3 });
  printEvalTable(payload);
  assert.equal(payload.summary.all_accepted, true);
  assert.equal(payload.summary.accepted, "10/10");
  assert.equal(payload.summary.baseline_pass, "0/30");
  assert.equal(payload.summary.patched_pass, "30/30");
});
