#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(root, "node_modules/failproofai/dist/cli.mjs");
const rest = process.argv.slice(2);
const args =
  rest.length > 0
    ? rest
    : ["policies", "show", "sank8-2/discord-pr-triage-guard", "--releases"];

const child = spawn(process.execPath, [cliPath, ...args], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
