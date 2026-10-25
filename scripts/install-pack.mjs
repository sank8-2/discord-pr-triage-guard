#!/usr/bin/env node
/**
 * Install sank8-2/discord-pr-triage-guard into the local Failproof store
 * and print a clear error if fetch/verification fails.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Import pack-store from the package source via the CLI bundle is hard;
// call the same CLI entry but capture stderr thoroughly.
import { spawn } from "node:child_process";

const cli = join(root, "node_modules", "failproofai", "dist", "cli.mjs");
const source = process.argv[2] ?? "sank8-2/discord-pr-triage-guard@0.1.0";
const args = ["policies", "add", source, "--all", "--cli", "cursor"];

const child = spawn(process.execPath, [cli, ...args], {
  cwd: root,
  env: {
    ...process.env,
    NODE_DEBUG: process.env.NODE_DEBUG ?? "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => {
  out += d;
  process.stderr.write(d);
});
child.on("exit", async (code) => {
  if (code === 0) process.exit(0);

  // Fallback: try a deeper import of addPack for a stack trace
  try {
    const storePath = join(root, "node_modules/failproofai/src/hooks/pack-store.ts");
    // TS may not load; use dynamic evaluation via the dist chunks if exported
    console.error("\n--- retrying via direct addPack diagnostic ---");
    const { addPack, parsePackSpec } = await import(
      pathToFileURL(join(root, "node_modules/failproofai/src/hooks/pack-store.ts")).href
    ).catch(() => ({}));
    if (!addPack) {
      console.error("Could not import addPack from source (expected without TS loader).");
      process.exit(code ?? 1);
    }
    const result = await addPack(source, { all: true, clis: ["cursor"] });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err);
    if (err?.cause) console.error("cause:", err.cause);
  }
  process.exit(code ?? 1);
});
