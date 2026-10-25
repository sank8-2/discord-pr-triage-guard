import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

test("GET /health and POST /github", async () => {
  const server = createServer({ policyMode: "on" });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.policyMode, "on");

    const response = await fetch(`${base}/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pr: {
          number: 101,
          title: "fix: typo",
          body: "small docs fix",
          author: "spammer",
          merged: true,
          merged_at: "2026-10-20T10:00:00Z",
          labels: ["spam"],
          diff_lines: 2,
          maintainer_approved: true,
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.awards, 0);
    assert.equal(body.pings, 0);
    assert.ok(body.policy_denials >= 1);
  } finally {
    server.close();
  }
});
