# 3-minute demo script

## Interactive UI (preferred)

```bash
# from repo root
node src/cli.mjs demo-ui --port 8790
# open http://127.0.0.1:8790/
```

Or: `node src/demo-server.mjs --port 8790` · `npm run demo-ui`.

**What judges see**

1. Hero: **Failproof** + Discord PR Triage Guard.
2. Scenario chips: Spam PR (default), Duplicate award, Ping / injection.
3. **Step 1 — Run baseline (unsafe):** spam PR → award ledger ticks, Discord ping fires, leaderboard updates, counters `awards`/`pings` rise, shield shows POLICY OFF.
4. **Step 2 — Run with Failproof:** same fixture → PreToolUse **deny** flash, `policy_denials` ticks, award/ping stay blocked, trace strip shows deny reason.
5. Optional: switch to Duplicate award and repeat the two-step — baseline double-pays; Failproof keeps one.

API (same server): `GET /demo/cases` · `POST /demo/run` `{ "caseId", "policy": "off"|"on" }`.

## Judge slides

Open the self-contained deck (no build step):

```bash
# from repo root
xdg-open docs/slides/index.html
# or
python3 -m http.server 8765 --directory docs/slides
# then visit http://localhost:8765/
```

**Keys:** `→` / `Space` next · `←` back · `F` fullscreen · swipe on mobile. 12 slides, ~3 min talk pace.

**0:00–0:25 — problem**

> A Discord community bot awards leaderboard points from GitHub PRs. The model can read the PR. The hard part is trusting it with the award and the ping.

**0:25–0:55 — baseline failure**

In the UI: click **Run baseline (unsafe)**. Or CLI:

```bash
node src/cli.mjs demo --case spam_pr_no_points --policy off
```

Point at the trace: baseline awards points to a spam PR and pings the spammer (`awards: 1`, `pings: 1`, `policy_denials: 0`).

**0:55–1:35 — guarded behavior**

In the UI: click **Run with Failproof**. Or CLI:

```bash
node src/cli.mjs demo --case spam_pr_no_points --policy on
```

Point at: first `award_points` denied, rules fetched, PR scored, no award, no ping. Say:

> The policy didn’t ask the model to be careful. It made the side effect conditional on evidence.

**1:35–2:15 — two more gates**

```bash
node src/cli.mjs demo --case duplicate_award_once --policy on
node src/cli.mjs demo --case discord_ping_failure_no_duplicate_points --policy on
```

Show `policy_denials`, idempotent awards, and ping-only-after-commit.

**2:15–2:45 — eval table**

```bash
node src/cli.mjs eval
```

> 10 cases, 3 runs each. Baseline 0/30. Patched 30/30. Every case is a real failure mode: spam, duplicate, stale rules, injection, 429, 500, race.

**2:45–3:00 — close**

> We didn’t make the model smarter. We made every point and ping conditional, idempotent, and auditable.

Install for consumers (all three live packs @0.1.0 / Cloud v1 on fleet machine `sanketh`):

```bash
failproofai policies add sank8-2/discord-pr-triage-guard
failproofai policies add sank8-2/idempotent-writes
failproofai policies add sank8-2/policy-creation-guard
```
