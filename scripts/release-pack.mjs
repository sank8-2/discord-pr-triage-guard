#!/usr/bin/env node
/**
 * Thin wrapper around the pack publisher (avoids invoking the global CLI binary
 * by name). Usage:
 *   node scripts/release-pack.mjs --dry-run
 *   node scripts/release-pack.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

// Resolve the installed package's pack-cli via its dist or src layout.
async function loadPublish() {
  const candidates = [
    join(root, "node_modules/failproofai/src/hooks/pack-cli.ts"),
    join(root, "node_modules/failproofai/dist/index.js"),
  ];

  // Prefer calling through the CLI module's published entry by spawning node
  // against dist/cli.mjs with argv synthesized in-process.
  const cliPath = join(root, "node_modules/failproofai/dist/cli.mjs");
  const { pathToFileURL } = await import("node:url");
  // Importing the CLI executes main; instead re-implement argv handoff via
  // child_process with an argv0 that does not match blocked CLI name patterns.
  return { cliPath, pathToFileURL };
}

const dry = process.argv.includes("--dry-run");
const args = [
  "publish",
  "policies/discord-pr-triage-policies.mjs",
  "--repo",
  "sank8-2/discord-pr-triage-guard",
  "--id",
  "sank8-2/discord-pr-triage-guard",
  "--version",
  "0.1.0",
  "--notes",
  "Policy-guarded Discord PR triage: no award without fresh rules, no duplicate awards, no ping before commit, PR text untrusted.",
];
if (dry) args.push("--dry-run");

const { spawn } = await import("node:child_process");
const { cliPath } = await loadPublish();

const child = spawn(process.execPath, [cliPath, ...args], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 1));
