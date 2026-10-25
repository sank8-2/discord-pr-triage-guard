#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.mjs";
import { buildScenario, printEvalTable, runEvals } from "./evals.mjs";
import { createServer } from "./server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`Usage:
  node src/cli.mjs list
  node src/cli.mjs demo --case <id> --policy on|off
  node src/cli.mjs eval [--case <id>]
  node src/cli.mjs serve [--port 8787]
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function loadCases() {
  return JSON.parse(
    await readFile(join(ROOT, "evals/cases.json"), "utf8")
  );
}

async function loadRules() {
  return JSON.parse(
    await readFile(join(ROOT, "rules/community-rules.json"), "utf8")
  );
}

async function cmdList() {
  const cases = await loadCases();
  for (const entry of cases) {
    console.log(
      `${entry.id.padEnd(40)} ${entry.kind.padEnd(8)} ${entry.failure_mode}`
    );
  }
}

async function cmdDemo(args) {
  const caseId = args.case ?? "spam_pr_no_points";
  const policy = args.policy === "on" ? "on" : "off";
  const cases = await loadCases();
  const caseDef = cases.find((entry) => entry.id === caseId);
  if (!caseDef) {
    console.error(`Unknown case: ${caseId}`);
    process.exitCode = 1;
    return;
  }

  const rules = await loadRules();
  const scenario = buildScenario(caseDef, rules);
  const planner = policy === "on" ? "guarded" : "naive";
  const result = await runAgent({ scenario, policyMode: policy, planner });

  console.log(
    JSON.stringify(
      {
        case: caseId,
        policy,
        planner,
        awards: result.awards,
        pings: result.pings,
        winner: result.winner,
        duplicates: result.duplicates,
        policy_denials: result.policy_denials,
        retries: result.retries,
        status: result.status,
        expect: caseDef.expect,
      },
      null,
      2
    )
  );

  if (args.trace || process.env.FAILPROOFAI_TRACE === "1") {
    console.log("--- trace ---");
    console.log(JSON.stringify(result.trace, null, 2));
  }
}

async function cmdEval(args) {
  const payload = await runEvals({
    caseFilter: typeof args.case === "string" ? args.case : null,
  });
  printEvalTable(payload);
  if (!payload.summary.all_accepted) process.exitCode = 1;
}

async function cmdServe(args) {
  const port = Number(args.port ?? 8787);
  const policyMode = args.policy === "off" ? "off" : "on";
  const server = createServer({ policyMode });
  server.listen(port, "127.0.0.1", () => {
    console.log(`listening on http://127.0.0.1:${port} (policy=${policyMode})`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === "help" || args.help) {
    usage();
    return;
  }

  if (command === "list") return cmdList();
  if (command === "demo") return cmdDemo(args);
  if (command === "eval") return cmdEval(args);
  if (command === "serve") return cmdServe(args);

  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
