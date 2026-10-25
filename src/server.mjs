import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.mjs";
import { deepMerge } from "./evals.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadBaseRules() {
  return JSON.parse(
    await readFile(join(ROOT, "rules/community-rules.json"), "utf8")
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Stateless demo webhook server.
 * Each request builds a fresh runtime; nothing is shared across requests.
 */
export function createServer({ policyMode = "on" } = {}) {
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, policyMode });
      }

      if (req.method === "POST" && url.pathname === "/github") {
        const body = await readJson(req);
        const baseRules = await loadBaseRules();
        const rules = body.rulesOverrides
          ? deepMerge(baseRules, body.rulesOverrides)
          : baseRules;

        const scenario = {
          kind: body.kind ?? "triage",
          repo: body.repo ?? rules.repo,
          rules,
          currentRulesVersion:
            body.currentRulesVersion ?? rules.version,
          maintainer: body.maintainer ?? "maintainer",
          pr: body.pr,
          prs: body.prs,
          deliveries: body.deliveries,
          initialAwards: body.initialAwards,
          initialLeaderboard: body.initialLeaderboard,
          githubResponses: body.githubResponses,
          discordResponses: body.discordResponses,
        };

        const mode = body.policyMode ?? policyMode;
        const planner = mode === "on" ? "guarded" : "naive";
        const result = await runAgent({
          scenario,
          policyMode: mode,
          planner,
        });

        return sendJson(res, 200, {
          ok: true,
          policyMode: mode,
          planner,
          awards: result.awards,
          pings: result.pings,
          winner: result.winner,
          duplicates: result.duplicates,
          policy_denials: result.policy_denials,
          retries: result.retries,
          status: result.status,
        });
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: error?.message ?? String(error),
      });
    }
  });
}

export { deepMerge };
