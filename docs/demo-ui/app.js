const $ = (id) => document.getElementById(id);

const PACK_HINTS = {
  triage:
    "All 10 fixtures from evals/cases.json — baseline (off) then Failproof (on).",
  "idempotent-writes":
    "Sibling pack · POST without key → deny; with key → allow; duplicate / timeout retries.",
  "policy-creation-guard":
    "Sibling pack · unapproved publish → deny; with approval → instruct / allow.",
};

const state = {
  packId: "triage",
  caseId: "spam_pr_no_points",
  cases: [],
  packs: [],
  lastPolicy: null,
  animating: false,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function activeCases() {
  if (state.packId === "triage") return state.cases;
  const pack = state.packs.find((p) => p.id === state.packId);
  return (pack?.cases ?? []).map((c) => ({
    id: c.id,
    label: c.label,
    blurb: c.blurb,
    name: c.label,
    pack: state.packId,
    expect: c.expect ?? null,
  }));
}

function currentCase() {
  return activeCases().find((c) => c.id === state.caseId) ?? activeCases()[0];
}

async function fetchCases() {
  const res = await fetch("/demo/cases");
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "failed to load cases");
  state.cases = data.cases ?? [];
  state.packs = data.packs ?? [];
  if (!state.cases.some((c) => c.id === state.caseId)) {
    state.caseId = state.cases[0]?.id ?? state.caseId;
  }
  renderPackTabs();
  renderScenarios();
  const c = currentCase();
  if (c) {
    setVerdict({
      tone: "idle",
      label: "Scenario",
      title: c.name ?? c.label,
      detail: c.blurb ?? "",
    });
  }
}

function renderPackTabs() {
  const tabs = $("packTabs");
  if (!tabs) return;
  for (const btn of tabs.querySelectorAll(".pack-tab")) {
    const pack = btn.dataset.pack;
    btn.setAttribute("aria-selected", String(pack === state.packId));
  }
  const hint = $("packHint");
  if (hint) {
    hint.innerHTML = PACK_HINTS[state.packId] ?? "";
  }
  const title = $("contextTitle");
  if (title) {
    title.textContent =
      state.packId === "triage" ? "Incoming PR" : "Tool call under test";
  }
}

function selectPack(packId) {
  if (state.animating || packId === state.packId) return;
  state.packId = packId;
  state.lastPolicy = null;
  $("btnFailproof").disabled = true;
  const list = activeCases();
  state.caseId = list[0]?.id ?? state.caseId;
  renderPackTabs();
  renderScenarios();
  resetVisuals();
  const c = currentCase();
  setVerdict({
    tone: "idle",
    label: "Pack",
    title: c?.name ?? c?.label ?? packId,
    detail: c?.blurb ?? PACK_HINTS[packId] ?? "",
  });
}

function renderScenarios() {
  const row = $("scenarioRow");
  row.innerHTML = "";
  for (const c of activeCases()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scenario-chip";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(c.id === state.caseId));
    btn.textContent = c.label;
    btn.title = c.blurb ?? c.name ?? c.id;
    btn.addEventListener("click", () => {
      if (state.animating) return;
      state.caseId = c.id;
      state.lastPolicy = null;
      $("btnFailproof").disabled = true;
      renderScenarios();
      resetVisuals();
      setVerdict({
        tone: "idle",
        label: "Scenario",
        title: c.name ?? c.label,
        detail: c.blurb ?? "",
      });
    });
    row.appendChild(btn);
  }
}

function resetVisuals() {
  setMeters({ awards: 0, pings: 0, denials: 0 }, { bump: false });
  $("pipeline").innerHTML = "";
  $("awardLedger").innerHTML = "";
  $("pingLog").innerHTML = "";
  $("leaderboard").innerHTML = "";
  $("traceStrip").innerHTML = "";
  $("prNum").textContent = "#—";
  $("prTitle").textContent = "Waiting for a run…";
  $("prAuthor").textContent = "—";
  $("prBody").textContent = "";
  $("prLabels").innerHTML = "";
  setShield("idle", "GATE IDLE", "PreToolUse · deny › instruct › allow");
}

function setVerdict({ tone, label, title, detail }) {
  const el = $("verdict");
  el.dataset.tone = tone ?? "idle";
  el.querySelector(".verdict-label").textContent = label ?? "Ready";
  el.querySelector(".verdict-title").textContent = title ?? "";
  el.querySelector(".verdict-detail").textContent = detail ?? "";
}

function setShield(mode, title, sub) {
  const el = $("shield");
  el.dataset.state = mode;
  $("shieldMode").textContent = title;
  $("shieldSub").textContent = sub;
}

function setMeters({ awards, pings, denials }, { bump = true } = {}) {
  const map = [
    ["meterAwards", awards, "awards"],
    ["meterPings", pings, "pings"],
    ["meterDenials", denials, "denials"],
  ];
  for (const [id, value, key] of map) {
    const node = $(id);
    const prev = Number(node.textContent);
    node.textContent = String(value);
    node.classList.remove("bump", "hot");
    if (bump && value !== prev) {
      void node.offsetWidth;
      node.classList.add("bump");
      if (key !== "denials" && value > 0) node.classList.add("hot");
    }
  }
}

function renderPr(pr) {
  if (!pr) return;
  $("prNum").textContent = `#${pr.number}`;
  $("prTitle").textContent = pr.title ?? "";
  $("prAuthor").textContent = pr.author ?? "—";
  $("prBody").textContent = pr.body ?? "";
  const labels = $("prLabels");
  labels.innerHTML = "";
  for (const label of pr.labels ?? []) {
    const tag = document.createElement("span");
    tag.className = "tag" + (label === "spam" ? "" : " ok");
    tag.textContent = label;
    labels.appendChild(tag);
  }
}

function renderPackContext(data) {
  $("prNum").textContent = data.tool ?? "tool";
  $("prTitle").textContent = data.name ?? data.caseId ?? "";
  $("prAuthor").textContent = data.packId ?? state.packId;
  const input = data.input ?? {};
  $("prBody").textContent =
    typeof input.command === "string"
      ? input.command
      : JSON.stringify(input, null, 2);
  const labels = $("prLabels");
  labels.innerHTML = "";
  const tag = document.createElement("span");
  tag.className = "tag ok";
  tag.textContent = data.decision ?? "pending";
  labels.appendChild(tag);
}

function appendPipeline(entry) {
  const li = document.createElement("li");
  const kind =
    entry.type === "tool"
      ? "tool"
      : entry.decision === "deny"
        ? "deny"
        : entry.decision === "allow"
          ? "allow"
          : entry.decision === "instruct"
            ? "tool"
            : "tool";
  li.className = `pipeline-item ${kind}`;
  const dec = document.createElement("span");
  dec.className = "pipeline-dec";
  dec.textContent =
    entry.type === "tool" ? "run" : (entry.decision ?? entry.type ?? "event");
  const tool = document.createElement("span");
  tool.className = "pipeline-tool";
  tool.textContent = entry.tool ?? "—";
  li.append(dec, tool);
  if (entry.reason || entry.summary || entry.policy) {
    const reason = document.createElement("span");
    reason.className = "pipeline-reason";
    reason.textContent = [entry.policy, entry.reason ?? entry.summary]
      .filter(Boolean)
      .join(" — ");
    li.appendChild(reason);
  }
  $("pipeline").appendChild(li);
  $("pipeline").scrollTop = $("pipeline").scrollHeight;
}

function appendTraceChip(entry) {
  const chip = document.createElement("span");
  const kind =
    entry.type === "tool"
      ? "tool"
      : entry.decision === "deny"
        ? "deny"
        : entry.decision === "instruct"
          ? "tool"
          : "allow";
  chip.className = `trace-chip ${kind}`;
  const label =
    entry.type === "tool"
      ? `⚙ ${entry.tool}`
      : `${entry.decision?.toUpperCase?.() ?? "?"} ${entry.tool}`;
  chip.textContent = label;
  if (entry.reason) chip.title = entry.reason;
  $("traceStrip").appendChild(chip);
  $("traceStrip").scrollLeft = $("traceStrip").scrollWidth;
}

function renderLedger(data) {
  const awards = $("awardLedger");
  const pings = $("pingLog");
  const board = $("leaderboard");
  awards.innerHTML = "";
  pings.innerHTML = "";
  board.innerHTML = "";

  for (const a of data.award_ledger ?? []) {
    const li = document.createElement("li");
    li.className = "tick";
    li.textContent = `+${a.points} → @${a.contributor} (PR #${a.pr_number})`;
    awards.appendChild(li);
  }
  for (const p of data.ping_log ?? []) {
    const li = document.createElement("li");
    li.className = "tick";
    li.textContent = `Discord ping → @${p.winner_id}`;
    pings.appendChild(li);
  }
  for (const row of data.leaderboard ?? []) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${row.contributor}</strong><span>${row.points} pts</span>`;
    board.appendChild(li);
  }

  // Pack demos: surface policy decisions in the ledger panel.
  if (data.kind === "pack" && Array.isArray(data.policies)) {
    for (const p of data.policies) {
      const li = document.createElement("li");
      li.className = p.decision === "deny" ? "" : "tick";
      li.textContent = `${p.decision} · ${p.name}${p.reason ? ` — ${p.reason}` : ""}`;
      awards.appendChild(li);
    }
  }
}

async function animateRun(data) {
  if (data.kind === "pack" || data.packId) {
    renderPackContext(data);
  } else {
    renderPr(data.pr);
  }
  $("pipeline").innerHTML = "";
  $("traceStrip").innerHTML = "";
  $("awardLedger").innerHTML = "";
  $("pingLog").innerHTML = "";
  $("leaderboard").innerHTML = "";

  const policyOn = data.policy === "on";
  setShield(
    policyOn ? "on" : "off",
    policyOn ? "FAILPROOF ON" : "POLICY OFF",
    policyOn
      ? "PreToolUse evaluating every side-effect tool"
      : "Naive / ungated — tool proceeds"
  );

  setMeters({ awards: 0, pings: 0, denials: 0 }, { bump: false });

  let awards = 0;
  let pings = 0;
  let denials = 0;

  const trace = data.trace ?? [];
  for (const entry of trace) {
    appendPipeline(entry);
    appendTraceChip(entry);

    if (entry.type === "policy" && entry.decision === "deny") {
      denials += 1;
      setMeters({ awards, pings, denials });
      setShield("deny", "DENIED", entry.reason ?? "PreToolUse deny");
      await sleep(280);
    } else if (entry.type === "tool" && entry.tool === "award_points") {
      awards += 1;
      setMeters({ awards, pings, denials });
      const li = document.createElement("li");
      li.className = "tick";
      li.textContent = entry.summary ?? "award";
      $("awardLedger").appendChild(li);
      await sleep(220);
    } else if (entry.type === "tool" && entry.tool === "ping_winner") {
      pings += 1;
      setMeters({ awards, pings, denials });
      const li = document.createElement("li");
      li.className = "tick";
      li.textContent = entry.summary ?? "ping";
      $("pingLog").appendChild(li);
      await sleep(220);
    } else if (entry.type === "tool" && entry.tool === "commit_leaderboard") {
      await sleep(160);
    } else {
      await sleep(90);
    }
  }

  setMeters(
    {
      awards: data.awards ?? awards,
      pings: data.pings ?? pings,
      denials: data.policy_denials ?? denials,
    },
    { bump: true }
  );
  renderLedger(data);

  if (policyOn && (data.policy_denials > 0 || data.decision === "deny")) {
    setShield(
      "deny",
      "SIDE EFFECT BLOCKED",
      data.verdict?.detail ?? data.reason ?? "Gate held."
    );
  } else if (policyOn) {
    setShield(
      "on",
      data.decision === "instruct" ? "INSTRUCT" : "GATED PATH OK",
      data.verdict?.detail ?? data.reason ?? ""
    );
  } else {
    setShield(
      "off",
      data.awards > 0 || data.pings > 0 || data.decision === "allow"
        ? "BLAST RADIUS HIT"
        : "BASELINE DONE",
      data.verdict?.detail ?? ""
    );
  }

  const v = data.verdict ?? {};
  setVerdict({
    tone: v.tone ?? (policyOn ? "safe" : "unsafe"),
    label: policyOn ? "With Failproof" : "Baseline (unsafe)",
    title: v.title ?? "",
    detail: v.detail ?? "",
  });
}

async function runDemo(policy) {
  if (state.animating) return;
  state.animating = true;
  document.body.classList.add("running");
  $("btnBaseline").disabled = true;
  $("btnFailproof").disabled = true;

  setVerdict({
    tone: "idle",
    label: "Running",
    title: policy === "on" ? "Failproof gate engaged…" : "Baseline…",
    detail: `pack=${state.packId} · case=${state.caseId} · policy=${policy}`,
  });

  try {
    const body = {
      caseId: state.caseId,
      policy,
      packId: state.packId === "triage" ? "triage" : state.packId,
    };
    const res = await fetch("/demo/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "run failed");
    await animateRun(data);
    state.lastPolicy = policy;
  } catch (error) {
    setVerdict({
      tone: "unsafe",
      label: "Error",
      title: "Demo run failed",
      detail: error?.message ?? String(error),
    });
  } finally {
    state.animating = false;
    document.body.classList.remove("running");
    $("btnBaseline").disabled = false;
    $("btnFailproof").disabled = false;
  }
}

$("btnBaseline").addEventListener("click", () => runDemo("off"));
$("btnFailproof").addEventListener("click", () => runDemo("on"));

$("packTabs")?.addEventListener("click", (event) => {
  const btn = event.target.closest(".pack-tab");
  if (!btn) return;
  selectPack(btn.dataset.pack);
});

fetchCases().catch((error) => {
  setVerdict({
    tone: "unsafe",
    label: "Error",
    title: "Could not load cases",
    detail: error?.message ?? String(error),
  });
});
