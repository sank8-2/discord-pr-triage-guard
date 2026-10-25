import { pathToFileURL } from "node:url";
import * as failproof from "failproofai";

const { getCustomHooks, clearCustomHooks } = failproof.default ?? failproof;

const DEFAULT_POLICY_PATH = new URL(
  "../policies/discord-pr-triage-policies.mjs",
  import.meta.url
);

let hooksPromise;

function toModuleUrl(policyPath) {
  if (policyPath instanceof URL) return policyPath.href;
  if (typeof policyPath === "string" && /^file:/.test(policyPath)) {
    return policyPath;
  }
  return pathToFileURL(policyPath).href;
}

async function loadHooks(policyPath) {
  if (!hooksPromise) {
    hooksPromise = (async () => {
      clearCustomHooks();
      await import(toModuleUrl(policyPath));
      return getCustomHooks();
    })();
  }
  return hooksPromise;
}

/**
 * Evaluate every PreToolUse policy against a tool call. The strictest verdict
 * wins: deny > instruct > allow. A policy that throws fails open, matching
 * Failproof's own execution model.
 */
export async function evaluatePolicy(
  toolName,
  toolInput,
  { policyPath = DEFAULT_POLICY_PATH } = {}
) {
  const hooks = await loadHooks(policyPath);
  const results = [];

  for (const hook of hooks) {
    if (!hook.match?.events?.includes("PreToolUse")) continue;

    let result;
    try {
      result = await hook.fn({
        eventType: "PreToolUse",
        toolName,
        toolInput,
        payload: { tool_name: toolName, tool_input: toolInput },
      });
    } catch (error) {
      result = {
        decision: "allow",
        reason: `policy error: ${error.message}`,
      };
    }

    results.push({
      name: hook.name,
      description: hook.description ?? null,
      decision: result.decision ?? "allow",
      reason: result.reason ?? null,
    });
  }

  const denied = results.find((entry) => entry.decision === "deny");
  const instructed = results.find((entry) => entry.decision === "instruct");

  return {
    decision: denied ? "deny" : instructed ? "instruct" : "allow",
    reason: denied?.reason ?? instructed?.reason ?? null,
    results,
  };
}
