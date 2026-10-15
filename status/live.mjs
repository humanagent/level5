// Live runs: what a Claude Code session or a Managed Agents session is doing while it runs,
// folded from its OpenTelemetry records (otlp.mjs) into one row per run. Claude Code sends logs
// (tool_result, api_request, api_error, user_prompt, skill_activated); the Claude Platform sends
// spans. A run is running while records keep arriving, and ended after IDLE_MS of silence.
// Kept: counts, tokens, cost, the last steps and errors. Not kept: prompts, outputs, emails.

export const IDLE_MS = 10 * 60e3;
const STEPS = 40, ERRS = 12;
// a slash command that names no skill
const BUILTIN = /^(add-dir|agents|bug|clear|compact|config|context|cost|doctor|exit|export|help|hooks|ide|init|login|logout|mcp|memory|model|permissions|pr-comments|release-notes|resume|review|status|statusline|terminal-setup|upgrade|vim)$/;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const yes = (v) => v === true || v === "true";
const cut = (s, k) => String(s ?? "").slice(0, k);

// Claude Code: session.id; the Claude Platform: anthropic.session.id. Anything else is not a run.
function runOf(r) {
  if (r.attrs["anthropic.session.id"]) return { id: "ma:" + r.attrs["anthropic.session.id"], source: "platform" };
  if (r.attrs["session.id"] && String(r.attrs["service.name"] || "").startsWith("claude-code")) return { id: "cc:" + r.attrs["session.id"], source: "claude-code" };
  return null;
}

// what a tool call was, in a few words: the skill, the MCP tool or the command
function toolLabel(a) {
  let p = {};
  try { p = JSON.parse(a.tool_parameters || "{}"); } catch {}
  const t = a.tool_name || "tool";
  if (p.skill_name) return `Skill ${p.skill_name}`;
  if (p.mcp_server_name) return `${p.mcp_server_name} ${p.mcp_tool_name || ""}`.trim();
  if (p.bash_command) return `${t} ${cut(p.bash_command, 40)}`;
  if (p.file_path) return `${t} ${cut(String(p.file_path).split("/").pop(), 40)}`;
  return t;
}
const sameKey = (a) => `${a.tool_name || ""}|${cut(a.tool_parameters || a.tool_input || "", 300)}`;

function fold(run, r) {
  const a = r.attrs, b = run.body, at = r.end || r.ts;
  run.started_at = Math.min(run.started_at || at, r.ts || at);
  run.last_at = Math.max(run.last_at || 0, at);
  if (a["ccr.session.id"]) [run.place, b.ccr] = ["cloud", cut(a["ccr.session.id"], 80)];
  const step = (s) => { b.steps.push({ t: at, ...s }); if (b.steps.length > STEPS) b.steps.splice(0, b.steps.length - STEPS); };
  const err = (what, e) => { run.errors++; b.errs.push({ t: at, what: cut(what, 80), error: cut(e, 300) }); if (b.errs.length > ERRS) b.errs.shift(); };

  if (run.source === "claude-code") {
    if (r.name === "user_prompt" && a.command_name && !BUILTIN.test(String(a.command_name).replace(/^\//, "")) && !b.named) [run.name, b.named] = [cut(String(a.command_name).replace(/^\//, ""), 80), "command"];
    else if (r.name === "skill_activated" && a["skill.name"]) { if (!b.named) [run.name, b.named] = [cut(a["skill.name"], 80), "skill"]; step({ what: `Skill ${cut(a["skill.name"], 60)}`, ok: true }); }
    else if (r.name === "tool_result") {
      run.tool_calls++;
      const ok = yes(a.success), what = toolLabel(a), key = sameKey(a);
      b.streak = b.streak?.key === key ? { key, what, n: b.streak.n + 1 } : { key, what, n: 1 };
      b.tools[a.tool_name || "tool"] = (b.tools[a.tool_name || "tool"] || 0) + 1;
      step({ what, ok, ms: n(a.duration_ms) });
      if (!ok) err(what, a.error || a.error_type || "failed");
    } else if (r.name === "api_request") {
      run.tokens += n(a.input_tokens) + n(a.output_tokens) + n(a.cache_read_tokens) + n(a.cache_creation_tokens);
      run.usd += n(a.cost_usd);
      if (a.model) b.model = cut(a.model, 60);
    } else if (r.name === "api_error") err(`API ${a.status_code || ""}`.trim(), a.error);
    else if (r.name === "mcp_server_connection" && /fail|error/i.test(String(a.status || "")) ) err(`MCP ${a.server_name || ""}`.trim(), a.error || a.error_code || a.status);
    if (!run.place) run.place = a["app.entrypoint"] === "sdk-cli" ? "sdk" : "local";
  } else {
    run.place = "api";
    const agent = a["anthropic.agent.name"] || a["gen_ai.agent.name"];
    if (agent && !b.named) [run.name, b.named] = [cut(agent, 80), "agent"];
    if (r.name === "anthropic.model_request" || r.name === "anthropic.session.outcome_evaluation") {
      run.tokens += n(a["gen_ai.usage.input_tokens"]) + n(a["gen_ai.usage.output_tokens"]);
      if (a["gen_ai.request.model"] || a["gen_ai.response.model"]) b.model = cut(a["gen_ai.response.model"] || a["gen_ai.request.model"], 60);
    }
    if (/tool_use/.test(r.name)) {
      run.tool_calls++;
      const tool = a["gen_ai.tool.name"] || r.name.split(" ").slice(1).join(" ") || r.name.replace(/^anthropic\./, "");
      const ok = r.status?.code !== 2, key = `${tool}|${cut(a["gen_ai.tool.call.arguments"] || "", 300)}`;
      b.streak = b.streak?.key === key ? { key, what: tool, n: b.streak.n + 1 } : { key, what: tool, n: 1 };
      b.tools[tool] = (b.tools[tool] || 0) + 1;
      step({ what: cut(tool, 80), ok, ms: r.end && r.ts ? r.end - r.ts : 0 });
      if (!ok) err(tool, r.status?.message || a["error.type"] || "failed");
    } else if (r.status?.code === 2) err(r.name.replace(/^anthropic\./, ""), r.status.message || a["error.type"] || "failed");
  }
}

// Stuck, while it runs: the same call over and over, far longer or far more tokens than its
// usual run, or errors piling up. "usual" is the median of its last ended runs (3 or more).
export function flagsOf(run, past = []) {
  const out = [], dur = run.last_at - run.started_at, med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length >= 3 ? s[Math.floor(s.length / 2)] : null; };
  const mDur = med(past.map((p) => p.last_at - p.started_at)), mTok = med(past.map((p) => Number(p.tokens)));
  if (run.body.streak?.n >= 8) out.push({ kind: "loop", detail: `${run.body.streak.what}, ${run.body.streak.n} times in a row` });
  if (dur > Math.max(40 * 60e3, mDur ? 3 * mDur : 0)) out.push({ kind: "long", detail: `running ${Math.round(dur / 60e3)} min${mDur ? `, usually ${Math.max(1, Math.round(mDur / 60e3))}` : ""}` });
  if (mTok && run.tokens > Math.max(200e3, 3 * mTok)) out.push({ kind: "burn", detail: `${Math.round(run.tokens / 1e3)}k tokens, usually ${Math.round(mTok / 1e3)}k` });
  if (run.errors >= 5) out.push({ kind: "errors", detail: `${run.errors} errors, last: ${run.body.errs.at(-1)?.what || ""}` });
  return out;
}

// one batch of records into the runs table; answers the flags raised for the first time
export async function ingest(db, repoId, records) {
  const by = new Map();
  for (const r of records) {
    const k = runOf(r);
    if (!k) continue;
    if (!by.has(k.id)) by.set(k.id, { ...k, list: [] });
    by.get(k.id).list.push(r);
  }
  const raised = [];
  for (const { id, source, list } of by.values()) {
    const row = await db.one("SELECT * FROM live_runs WHERE repo_id = $1 AND run_id = $2", repoId, id);
    const run = row
      ? { ...row, started_at: Number(row.started_at), last_at: Number(row.last_at), tokens: Number(row.tokens), usd: Number(row.usd), body: JSON.parse(row.body), flags: JSON.parse(row.flags) }
      : { run_id: id, source, name: source === "platform" ? "agent" : "session", place: "", started_at: 0, last_at: 0, tool_calls: 0, errors: 0, tokens: 0, usd: 0, body: { steps: [], errs: [], tools: {}, streak: null }, flags: [] };
    for (const r of list.sort((x, y) => x.ts - y.ts)) fold(run, r);
    const past = (await db.all("SELECT started_at, last_at, tokens FROM live_runs WHERE repo_id = $1 AND name = $2 AND run_id <> $3 AND last_at < $4 ORDER BY last_at DESC LIMIT 20", repoId, run.name, id, Date.now() - IDLE_MS)).map((p) => ({ started_at: Number(p.started_at), last_at: Number(p.last_at), tokens: Number(p.tokens) }));
    for (const f of flagsOf(run, past)) if (!run.flags.some((x) => x.kind === f.kind)) { run.flags.push({ ...f, at: Date.now() }); raised.push({ run, flag: f }); }
    await db.run(
      `INSERT INTO live_runs (repo_id, run_id, source, name, place, started_at, last_at, tool_calls, errors, tokens, usd, flags, body) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (repo_id, run_id) DO UPDATE SET name = excluded.name, place = excluded.place, started_at = excluded.started_at, last_at = excluded.last_at, tool_calls = excluded.tool_calls, errors = excluded.errors, tokens = excluded.tokens, usd = excluded.usd, flags = excluded.flags, body = excluded.body`,
      repoId, id, source, run.name, run.place || "", run.started_at, run.last_at, run.tool_calls, run.errors, run.tokens, run.usd, JSON.stringify(run.flags), JSON.stringify(run.body));
  }
  return raised;
}

// for the page: what runs now, and what ran in the last day
export async function readRuns(db, repoId, now = Date.now()) {
  const rows = await db.all("SELECT * FROM live_runs WHERE repo_id = $1 AND last_at > $2 ORDER BY last_at DESC LIMIT 200", repoId, now - 864e5);
  const runs = rows.map((r) => {
    const body = JSON.parse(r.body), last = Number(r.last_at);
    return { id: r.run_id, source: r.source, name: r.name, place: r.place, started_at: Number(r.started_at), last_at: last, running: now - last < IDLE_MS, tool_calls: Number(r.tool_calls), errors: Number(r.errors), tokens: Number(r.tokens), usd: Number(r.usd), flags: JSON.parse(r.flags), model: body.model || "", steps: body.steps.slice(-12), errs: body.errs, tools: body.tools };
  });
  return { running: runs.filter((r) => r.running), recent: runs.filter((r) => !r.running) };
}
