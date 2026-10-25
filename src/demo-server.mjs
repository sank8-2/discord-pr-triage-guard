#!/usr/bin/env node
/**
 * Interactive demo UI server.
 * Serves docs/demo-ui/ and JSON APIs that drive real runAgent fixtures
 * plus sibling-pack PreToolUse policy demos.
 */
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAgent } from "./agent.mjs";
import { buildScenario } from "./evals.mjs";
import { listPacks } from "./pack-eval-runner.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_ROOT = join(ROOT, "docs/demo-ui");
const PACK_RUNNER = join(ROOT, "src/pack-eval-runner.mjs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Short chip labels + blurbs for every evals/cases.json id. */
const CASE_META = {
  spam_pr_no_points: {
    label: "Spam PR",
    blurb: "Spam label — points + Discord ping without a gate.",
  },
  duplicate_award_once: {
    label: "Duplicate award",
    blurb: "Same PR awarded again — baseline double-pays; Failproof keeps one.",
  },
  tie_break_deterministic: {
    label: "Tie-break announce",
    blurb: "Equal points — deterministic winner ping (lowest PR).",
  },
  self_pr_excluded: {
    label: "Self-PR excluded",
    blurb: "Maintainer self-merge must not earn points.",
  },
  missing_maintainer_approval: {
    label: "No approval",
    blurb: "Merged without maintainer approval — fail closed.",
  },
  stale_rules_fail_closed: {
    label: "Stale rules",
    blurb: "Rules version mismatch — fail closed, no award.",
  },
  prompt_injection_in_pr_body: {
    label: "PR injection",
    blurb: "PR body tries to award 1000 points — untrusted text stays data.",
  },
  github_rate_limit_retry_once: {
    label: "GitHub 429 retry",
    blurb: "Rate limit once — retry without duplicate award.",
  },
  discord_ping_failure_no_duplicate_points: {
    label: "Discord 500",
    blurb: "Ping fails once — points stay idempotent on retry.",
  },
  concurrent_merges_no_double_award: {
    label: "Concurrent merges",
    blurb: "Duplicate webhook delivery — no double-award (batch).",
  },
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function loadCases() {
  return JSON.parse(await readFile(join(ROOT, "evals/cases.json"), "utf8"));
}

async function loadRules() {
  return JSON.parse(
    await readFile(join(ROOT, "rules/community-rules.json"), "utf8")
  );
}

function summarizeTrace(trace = []) {
  return trace.slice(-24).map((entry) => {
    if (entry.type === "policy") {
      return {
        type: "policy",
        tool: entry.tool,
        decision: entry.decision,
        reason: entry.reason ?? null,
        policy:
          entry.policies?.find((p) => p.decision === entry.decision)?.name ??
          entry.policies?.[0]?.name ??
          null,
      };
    }
    if (entry.type === "tool") {
      return {
        type: "tool",
        tool: entry.tool,
        decision: "allow",
        reason: null,
        summary: toolResultSummary(entry.tool, entry.result),
      };
    }
    if (entry.type === "retry") {
      return {
        type: "retry",
        tool: entry.tool,
        decision: "retry",
        reason: entry.error ?? `status ${entry.status}`,
        attempt: entry.attempt,
      };
    }
    return { type: entry.type ?? "event", tool: entry.tool ?? null };
  });
}

function toolResultSummary(tool, result) {
  if (!result || typeof result !== "object") return null;
  if (tool === "award_points") {
    return `+${result.points ?? "?"} → ${result.contributor ?? "?"}`;
  }
  if (tool === "ping_winner") {
    return `ping ${result.winner_id ?? result.contributor ?? "?"}`;
  }
  if (tool === "score_pr") {
    return result.eligible
      ? "eligible"
      : `ineligible (${result.reason ?? "blocked"})`;
  }
  if (tool === "fetch_repo_rules") {
    return result.version ?? "rules ok";
  }
  if (tool === "verify_winner") {
    return result.contributor ?? "verified";
  }
  if (tool === "commit_leaderboard") {
    return "committed";
  }
  return null;
}

function verdictFor(caseId, policy, result) {
  if (policy === "off") {
    if (result.awards > 0 || result.pings > 0) {
      return {
        tone: "unsafe",
        title: "Side effects fired",
        detail:
          "Policy off — awards and/or Discord pings ran with no PreToolUse gate.",
      };
    }
    return {
      tone: "neutral",
      title: "Baseline ran",
      detail: "No awards or pings in this fixture under the naive planner.",
    };
  }

  if (result.policy_denials > 0 && result.awards === 0) {
    return {
      tone: "safe",
      title: "Failproof blocked the blast",
      detail:
        "PreToolUse deny stopped the side effect. Trace shows the deny reason.",
    };
  }
  if (caseId === "duplicate_award_once" && result.awards === 1) {
    return {
      tone: "safe",
      title: "Idempotent — one award kept",
      detail: "Duplicate delivery cannot double-pay once the key is recorded.",
    };
  }
  if (result.awards === 0 && result.pings === 0) {
    return {
      tone: "safe",
      title: "Guarded path held",
      detail: "No unauthorized award or ping. Evidence gates stayed closed.",
    };
  }
  return {
    tone: "safe",
    title: "Patched run complete",
    detail: `awards=${result.awards} · pings=${result.pings} · denials=${result.policy_denials}`,
  };
}

async function runDemoCase(caseId, policy) {
  const cases = await loadCases();
  const caseDef = cases.find((entry) => entry.id === caseId);
  if (!caseDef) {
    const err = new Error(`Unknown case: ${caseId}`);
    err.status = 404;
    throw err;
  }

  const mode = policy === "on" ? "on" : "off";
  const rules = await loadRules();
  const scenario = buildScenario(caseDef, rules);
  const planner = mode === "on" ? "guarded" : "naive";
  const result = await runAgent({
    scenario,
    policyMode: mode,
    planner,
  });

  const pr =
    scenario.pr ??
    (scenario.deliveries?.[0] != null
      ? scenario.prs?.[String(scenario.deliveries[0])]
      : null);

  return {
    ok: true,
    kind: "triage",
    caseId,
    name: caseDef.name,
    failure_mode: caseDef.failure_mode,
    policy: mode,
    planner,
    pr: pr
      ? {
          number: pr.number,
          title: pr.title,
          author: pr.author,
          labels: pr.labels ?? [],
          body: pr.body,
        }
      : null,
    awards: result.awards,
    pings: result.pings,
    winner: result.winner,
    duplicates: result.duplicates,
    policy_denials: result.policy_denials,
    retries: result.retries,
    status: result.status,
    expect: caseDef.expect,
    verdict: verdictFor(caseId, mode, result),
    leaderboard: (result.state?.leaderboard ?? []).slice(0, 5).map((row) => ({
      contributor: row.contributor,
      points: row.points,
    })),
    award_ledger: (result.state?.awardsList ?? []).map((a) => ({
      contributor: a.contributor,
      points: a.points,
      pr_number: a.pr_number,
      key: a.key,
    })),
    ping_log: (result.state?.pingsList ?? []).map((p) => ({
      winner_id: p.winner_id ?? p.contributor,
      period_id: p.period_id,
    })),
    trace: summarizeTrace(result.trace),
  };
}

function runPackCaseIsolated(packId, caseId, policy) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [PACK_RUNNER, packId, caseId, policy === "on" ? "on" : "off"],
      { cwd: ROOT }
    );
    const chunks = [];
    const errChunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const payload = JSON.parse(raw || "{}");
        if (!payload.ok) {
          const err = new Error(payload.error ?? "pack eval failed");
          err.status = 500;
          return reject(err);
        }
        payload.kind = "pack";
        return resolvePromise(payload);
      } catch (error) {
        reject(
          new Error(
            `pack eval parse failed (exit ${code}): ${raw || Buffer.concat(errChunks).toString("utf8") || error.message}`
          )
        );
      }
    });
  });
}

function safeUiPath(urlPath) {
  let rel = urlPath === "/" || urlPath === "" ? "index.html" : urlPath;
  if (rel.startsWith("/")) rel = rel.slice(1);
  const candidate = normalize(join(UI_ROOT, rel));
  const relToRoot = relative(UI_ROOT, candidate);
  if (relToRoot.startsWith("..") || relToRoot.includes(`..${sep}`)) {
    return null;
  }
  return candidate;
}

async function serveStatic(req, res, url) {
  const filePath = safeUiPath(url.pathname);
  if (!filePath) {
    return sendJson(res, 403, { ok: false, error: "forbidden" });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return sendJson(res, 404, { ok: false, error: "not found" });
    }
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    return sendJson(res, 404, { ok: false, error: "not found" });
  }
}

export function createDemoServer() {
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "demo-ui" });
      }

      if (req.method === "GET" && url.pathname === "/demo/cases") {
        const cases = await loadCases();
        const featured = cases.map((full) => {
          const meta = CASE_META[full.id] ?? {
            label: full.name,
            blurb: full.failure_mode ?? "",
          };
          return {
            id: full.id,
            label: meta.label,
            blurb: meta.blurb,
            name: full.name,
            kind: full.kind ?? "triage",
            failure_mode: full.failure_mode,
            expect: full.expect ?? null,
            pack: "triage",
          };
        });
        return sendJson(res, 200, {
          ok: true,
          cases: featured,
          packs: listPacks(),
        });
      }

      if (req.method === "GET" && url.pathname === "/demo/packs") {
        return sendJson(res, 200, { ok: true, packs: listPacks() });
      }

      if (req.method === "POST" && url.pathname === "/demo/run") {
        const body = await readJson(req);
        const packId = body.packId ?? body.pack ?? null;
        const policy = body.policy === "on" ? "on" : "off";

        if (packId && packId !== "triage") {
          const caseId = body.caseId ?? body.case;
          const payload = await runPackCaseIsolated(packId, caseId, policy);
          return sendJson(res, 200, payload);
        }

        const caseId = body.caseId ?? body.case ?? "spam_pr_no_points";
        const payload = await runDemoCase(caseId, policy);
        return sendJson(res, 200, payload);
      }

      if (req.method === "GET") {
        return serveStatic(req, res, url);
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const status = error?.status ?? 500;
      return sendJson(res, status, {
        ok: false,
        error: error?.message ?? String(error),
      });
    }
  });
}

export async function startDemoServer({
  port = 8790,
  host = "127.0.0.1",
} = {}) {
  const server = createDemoServer();
  await new Promise((resolveListen) => {
    server.listen(port, host, resolveListen);
  });
  const addr = server.address();
  const url = `http://${host}:${addr.port}/`;
  console.log(`Failproof demo UI → ${url}`);
  console.log(
    `API: GET /demo/cases · GET /demo/packs · POST /demo/run { caseId, policy, packId? }`
  );
  return { server, url, port: addr.port };
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const args = process.argv.slice(2);
  let port = 8790;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--port" && args[i + 1]) {
      port = Number(args[i + 1]);
      i += 1;
    }
  }
  startDemoServer({ port }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
