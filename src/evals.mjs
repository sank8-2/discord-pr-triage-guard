import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RULES = join(ROOT, "rules/community-rules.json");
const DEFAULT_CASES = join(ROOT, "evals/cases.json");
const DEFAULT_RESULTS_JSON = join(ROOT, "results/results.json");
const DEFAULT_RESULTS_MD = join(ROOT, "results/results.md");

export function deepMerge(base, overrides) {
  if (overrides == null) return structuredClone(base);
  if (Array.isArray(overrides) || typeof overrides !== "object") {
    return structuredClone(overrides);
  }
  const out =
    base && typeof base === "object" && !Array.isArray(base)
      ? structuredClone(base)
      : {};
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function buildScenario(caseDef, baseRules) {
  const raw = caseDef.scenario ?? {};
  const {
    rulesOverrides,
    currentRulesVersion,
    maintainer,
    repo,
    ...rest
  } = raw;

  const rules = deepMerge(baseRules, rulesOverrides);
  return {
    kind: caseDef.kind ?? "triage",
    repo: repo ?? rules.repo ?? "sank8-2/discord-pr-triage-guard",
    rules,
    currentRulesVersion: currentRulesVersion ?? rules.version,
    maintainer: maintainer ?? "maintainer",
    ...rest,
  };
}

export function assertExpect(result, expect = {}) {
  const failures = [];

  for (const [key, value] of Object.entries(expect)) {
    if (key === "at_least") {
      for (const [metric, minimum] of Object.entries(value ?? {})) {
        const actual = result[metric] ?? 0;
        if (actual < minimum) {
          failures.push(`${metric}=${actual} < ${minimum}`);
        }
      }
      continue;
    }

    if (result[key] !== value) {
      failures.push(`${key}=${JSON.stringify(result[key])} != ${JSON.stringify(value)}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

async function runVariant(caseDef, scenario, variant) {
  const policyMode = variant === "patched" ? "on" : "off";
  const planner = variant === "patched" ? "guarded" : "naive";
  const result = await runAgent({ scenario, policyMode, planner });
  const assertion = assertExpect(result, caseDef.expect);
  return {
    variant,
    ok: assertion.ok,
    failures: assertion.failures,
    summary: {
      awards: result.awards,
      pings: result.pings,
      winner: result.winner,
      duplicates: result.duplicates,
      policy_denials: result.policy_denials,
      retries: result.retries,
      status: result.status,
    },
  };
}

export async function runCase(caseDef, baseRules, { runs = 3 } = {}) {
  const scenario = buildScenario(caseDef, baseRules);
  const baseline = [];
  const patched = [];

  for (let i = 0; i < runs; i += 1) {
    baseline.push(await runVariant(caseDef, buildScenario(caseDef, baseRules), "baseline"));
  }
  for (let i = 0; i < runs; i += 1) {
    patched.push(await runVariant(caseDef, buildScenario(caseDef, baseRules), "patched"));
  }

  const baselinePass = baseline.filter((r) => r.ok).length;
  const patchedPass = patched.filter((r) => r.ok).length;
  const accepted = baselinePass === 0 && patchedPass === runs;

  return {
    id: caseDef.id,
    name: caseDef.name,
    kind: caseDef.kind,
    failure_mode: caseDef.failure_mode,
    expect: caseDef.expect,
    scenario_preview: {
      kind: scenario.kind,
      repo: scenario.repo,
      currentRulesVersion: scenario.currentRulesVersion,
    },
    baseline: { pass: baselinePass, total: runs, runs: baseline },
    patched: { pass: patchedPass, total: runs, runs: patched },
    accepted,
  };
}

function formatTable(results) {
  const rows = [
    "| Case | Baseline | Patched | Accepted |",
    "|---|---|---|---|",
  ];
  for (const entry of results) {
    rows.push(
      `| ${entry.id} | ${entry.baseline.pass}/${entry.baseline.total} | ${entry.patched.pass}/${entry.patched.total} | ${entry.accepted ? "yes" : "no"} |`
    );
  }
  return rows.join("\n");
}

export async function runEvals({
  rulesPath = DEFAULT_RULES,
  casesPath = DEFAULT_CASES,
  resultsJsonPath = DEFAULT_RESULTS_JSON,
  resultsMdPath = DEFAULT_RESULTS_MD,
  runs = 3,
  caseFilter = null,
} = {}) {
  const baseRules = JSON.parse(await readFile(rulesPath, "utf8"));
  let cases = JSON.parse(await readFile(casesPath, "utf8"));
  if (caseFilter) {
    cases = cases.filter((c) => c.id === caseFilter);
  }

  const results = [];
  for (const caseDef of cases) {
    results.push(await runCase(caseDef, baseRules, { runs }));
  }

  const accepted = results.filter((r) => r.accepted).length;
  const baselinePass = results.reduce((sum, r) => sum + r.baseline.pass, 0);
  const patchedPass = results.reduce((sum, r) => sum + r.patched.pass, 0);
  const baselineTotal = results.reduce((sum, r) => sum + r.baseline.total, 0);
  const patchedTotal = results.reduce((sum, r) => sum + r.patched.total, 0);

  const summary = {
    accepted: `${accepted}/${results.length}`,
    baseline_pass: `${baselinePass}/${baselineTotal}`,
    patched_pass: `${patchedPass}/${patchedTotal}`,
    all_accepted: accepted === results.length,
  };

  const payload = {
    generated_at: new Date().toISOString(),
    summary,
    results,
  };

  await mkdir(dirname(resultsJsonPath), { recursive: true });
  await writeFile(resultsJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const md = [
    "# Discord PR Triage Guard — Eval Results",
    "",
    `Generated: ${payload.generated_at}`,
    "",
    `- accepted: ${summary.accepted}`,
    `- baseline pass: ${summary.baseline_pass}`,
    `- patched pass: ${summary.patched_pass}`,
    "",
    formatTable(results),
    "",
  ].join("\n");
  await writeFile(resultsMdPath, md);

  return payload;
}

export function printEvalTable(payload) {
  console.log(formatTable(payload.results));
  console.log("");
  console.log(`accepted: ${payload.summary.accepted}`);
  console.log(`baseline pass: ${payload.summary.baseline_pass}`);
  console.log(`patched pass: ${payload.summary.patched_pass}`);
}
