// The daily factory report: everything that happened in the factory on one day (UTC), section by
// section, as one email. Built from a repo's snapshot, so it says what the page says.
//
// The look follows a transactional-email canon: a warm ground the card floats on, ONE white card
// with a header band, the overall state in a pill, data in tinted strips, mono eyebrows over each
// section, and the accent colour kept for the single button. Values are inlined because email
// clients ignore CSS variables and <style> blocks; tables because Outlook ignores the rest.

const R = {
  accent: "#FF5B1F", ink: "#111113", inkSoft: "#55555C", inkMute: "#8A8A92",
  ground: "#F1EFEA", card: "#FFFFFF", band: "#FAF9F6", strip: "#F6F4F0", line: "#E8E4DC",
};
const TONES = { ok: { fg: "#0F7A45", bg: "#E7F5EE" }, alert: { fg: "#C0271D", bg: "#FDECEA" }, warn: { fg: "#B45309", bg: "#FDF1E1" } };
const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const EYEBROW = `font-family: ${MONO}; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; color: ${R.inkMute};`;

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const usd = (n) => (n == null ? "–" : n >= 1000 ? "$" + Math.round(n).toLocaleString("en-US") : "$" + Number(n).toFixed(2));
const kn = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n || 0)));
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

function pill(tone, text) {
  const t = TONES[tone];
  return `<span style="display: inline-block; padding: 4px 11px; border-radius: 999px; background-color: ${t.bg}; color: ${t.fg}; font-family: ${FONT}; font-size: 12px; font-weight: 600;">${esc(text)}</span>`;
}
// a row of numbers in a tinted strip
function stats(items) {
  const cells = items.filter(Boolean).map(([big, label, small]) => `<td valign="top" style="padding: 12px 14px; font-family: ${FONT};">
      <div style="font-size: 19px; font-weight: 700; color: ${R.ink}; letter-spacing: -0.02em; line-height: 1.2;">${big}</div>
      <div style="font-size: 12px; color: ${R.inkSoft}; margin-top: 2px;">${esc(label)}</div>${small ? `<div style="font-size: 11px; color: ${R.inkMute}; margin-top: 1px;">${small}</div>` : ""}</td>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${R.strip}; border-radius: 12px; table-layout: fixed;"><tr>${cells.join("")}</tr></table>`;
}
// a list of short lines: dot, text, right-hand detail
function lines(items, empty) {
  if (!items.length) return `<div style="font-family: ${FONT}; font-size: 13px; color: ${R.inkMute}; padding: 4px 0;">${esc(empty)}</div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items.map(([tone, text, right]) => `<tr>
      <td width="16" valign="top" style="padding: 7px 0 0 0;"><div style="width: 7px; height: 7px; border-radius: 50%; background-color: ${tone ? TONES[tone].fg : R.line};"></div></td>
      <td valign="top" style="padding: 3px 8px 3px 0; font-family: ${FONT}; font-size: 13.5px; color: ${R.ink}; line-height: 1.45;">${text}</td>
      <td valign="top" align="right" style="padding: 3px 0; font-family: ${FONT}; font-size: 12px; color: ${R.inkMute}; white-space: nowrap;">${right || ""}</td></tr>`).join("")}</table>`;
}
function section(title, body) {
  return `<tr><td style="padding: 22px 0 0 0;"><div style="${EYEBROW} padding-bottom: 9px;">${esc(title)}</div>${body}</td></tr>`;
}

/**
 * @param s      the repo's snapshot
 * @param opts   { origin, day: "YYYY-MM-DD" (UTC, default yesterday) }
 * @returns      { subject, html, text, day, needs }
 */
export function dailyReport(s, { origin = "", day } = {}) {
  day = day || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const on = (ts) => ts && String(ts).slice(0, 10) === day;
  const label = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const pageUrl = `${origin}/r/${s.repo}`;
  const prev7 = [...Array(7)].map((_, i) => new Date(Date.parse(day + "T00:00:00Z") - (i + 1) * 864e5).toISOString().slice(0, 10));

  // automations
  const A = s.automations || [];
  const autoRuns = A.flatMap((a) => (a.runs || []).filter((r) => on(r.at)).map((r) => ({ ...r, name: a.name })));
  const missed = A.filter((a) => !a.weekly && (a.buckets || []).length && (() => { const d = s.status?.daily?.dates || [], i = d.indexOf(day); return i >= 0 && a.buckets[a.buckets.length - d.length + i]?.s === "miss"; })());
  const degradedRuns = autoRuns.filter((r) => r.status !== "ok");
  const tokens = autoRuns.reduce((x, r) => x + Number(r.tokens || 0), 0), autoUsd = autoRuns.reduce((x, r) => x + Number(r.usd || 0), 0), secs = autoRuns.reduce((x, r) => x + Number(r.secs || 0), 0);

  // skills that need a look now
  const needs = (s.status?.groups || []).flatMap((g) => g.rows).filter((r) => ["dead", "degraded", "lying", "warn", "late"].includes(r.state));
  const NEED = { dead: "stopped", late: "missed the last run", degraded: "often degraded", lying: "read nothing", warn: "degraded" };

  // costs
  const C = s.costs, cd = C?.per_day?.find((p) => p.d === day);
  const avg7 = C ? prev7.map((d) => C.per_day.find((p) => p.d === d)?.total || 0).reduce((a, b) => a + b, 0) / 7 : 0;
  const srcName = (k) => ({ aws: "AWS", vercel: "Vercel", neon: "Neon", anthropic: "Anthropic API", "claude-code": "Claude Code", openai: "OpenAI", fly: "Fly" }[k] || k);

  // code
  const M = s.metrics, pd = M?.prs?.per_day?.find((p) => p.d === day), size = M?.prs?.size || {};
  const merged = (s.queue?.merged || []).filter((p) => on(p.merged_at));
  const opened = [...(s.queue?.prs || []), ...(s.queue?.merged || []), ...(s.queue?.closed || [])].filter((p) => on(p.created_at));
  const promos = (s.promotions?.history || []).filter((p) => on(p.merged_at));

  // CI
  const ciDay = (s.ci || []).map((w) => { const i = (w.dates || []).indexOf(day); return { w, m: i >= 0 ? w.mins?.[i] || 0 : 0, t: i >= 0 ? w.tips?.[i] : null }; });
  const ciMin = ciDay.reduce((a, x) => a + x.m, 0), ciRuns = ciDay.reduce((a, x) => a + (x.t ? x.t.ok + x.t.bad : 0), 0), ciBad = ciDay.filter((x) => x.t?.bad);

  // issues, reports
  const id = M?.issues?.per_day?.find((p) => p.d === day);
  const reports = (s.status?.reports || []).flatMap((r) => r.items.filter((x) => on(x.ts)).map((x) => ({ ...x, id: r.id })));

  const problems = missed.length + degradedRuns.length + ciBad.length + needs.filter((r) => r.state !== "late").length;
  const tone = missed.length || ciBad.length ? "alert" : problems ? "warn" : "ok";
  const headline = problems ? `${problems} thing${problems === 1 ? "" : "s"} to look at` : "A quiet, healthy day";

  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td>${pill(tone, problems ? "Needs a look" : "All clear")}</td></tr>
    <tr><td style="padding: 12px 0 2px 0; font-family: ${FONT}; font-size: 26px; font-weight: 700; color: ${R.ink}; letter-spacing: -0.03em; line-height: 1.15;">${esc(headline)}</td></tr>
    <tr><td style="font-family: ${FONT}; font-size: 14px; color: ${R.inkSoft};">${esc(label)} · ${esc(s.repo)}</td></tr>

    ${section("Automations", stats([
      [`${autoRuns.length}`, "runs", missed.length ? `<span style="color: ${TONES.alert.fg};">${missed.length} missed</span>` : "none missed"],
      [tokens ? kn(tokens) : "–", "tokens", ""],
      [autoUsd ? usd(autoUsd) : "–", "token cost", ""],
      [secs ? mins(secs / 60) : "–", "time", ""],
    ]) + `<div style="height: 10px;"></div>` + lines([
      ...missed.map((a) => ["alert", `<b>${esc(a.name)}</b> did not run`, esc(a.cron)]),
      ...degradedRuns.map((r) => ["warn", `<b>${esc(r.name)}</b>: ${esc(r.note || r.status)}`, ""]),
      ...autoRuns.filter((r) => r.status === "ok").slice(0, 8).map((r) => ["ok", `${esc(r.name)}`, r.note && r.note !== r.name ? esc(r.note) : ""]),
    ], "No automation ran."))}

    ${needs.length ? section("Skills that need a look", lines(needs.slice(0, 10).map((r) => [["dead", "late", "degraded"].includes(r.state) ? "alert" : "warn", `<b>${esc(r.id)}</b>`, esc(NEED[r.state] || r.state)]), "")) : ""}

    ${section("Costs", C && cd && cd.total > 0 ? stats([
      [usd(cd?.total || 0), "spent", avg7 ? `${(cd?.total || 0) >= avg7 ? "+" : ""}${pct((cd?.total || 0) - avg7, avg7)}% vs the 7-day average` : ""],
      ...Object.entries(cd?.by || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => [usd(v), srcName(k), ""]),
    ]) : lines([], C ? "Spend for this day has not arrived yet: providers report it a day late." : "No cost data."))}

    ${section("Code", stats([
      [`${merged.length || pd?.all || 0}`, "PRs merged", pd && pd.all ? `${pd.agents} by agents` : ""],
      [pd ? `<span style="color: ${TONES.ok.fg};">+${kn(pd.added || 0)}</span> <span style="color: ${TONES.alert.fg};">−${kn(pd.deleted || 0)}</span>` : "–", "lines", ""],
      [`${opened.length}`, "PRs opened", ""],
      [`${promos.length}`, "promotions", promos.length ? "to production" : ""],
    ]) + `<div style="height: 10px;"></div>` + lines(merged.slice(0, 8).map((p) => [null, `<a href="${esc(p.url)}" style="color: ${R.ink}; text-decoration: none;">${esc(p.title)}</a> <span style="color: ${R.inkMute};">#${p.number}</span>`, size[p.number] ? `+${size[p.number][0]} −${size[p.number][1]}` : ""]).concat(merged.length > 8 ? [[null, `<span style="color: ${R.inkMute};">and ${merged.length - 8} more</span>`, ""]] : []), "Nothing merged."))}

    ${section("CI", stats([
      [mins(ciMin), "of CI", ""],
      [`${ciRuns}`, "runs", ""],
      [`${ciBad.length}`, "workflows with failures", ""],
    ]) + (ciBad.length ? `<div style="height: 10px;"></div>` + lines(ciBad.map((x) => ["alert", `<b>${esc(x.w.name)}</b>`, `${x.t.bad} of ${x.t.ok + x.t.bad} failed`]), "") : ""))}

    ${section("Issues", stats([
      [`${id?.opened ?? "–"}`, "opened", ""],
      [`${id?.closed ?? "–"}`, "closed", ""],
      [`${M?.issues?.open ?? "–"}`, "open now", ""],
    ]))}

    ${reports.length ? section("Reports", lines(reports.map((x) => [x.status === "ok" ? "ok" : "warn", `<b>${esc(x.id)}</b>`, esc(x.title || x.note || "")]), "")) : ""}

    <tr><td style="padding: 28px 0 0 0;">
      <a href="${esc(pageUrl)}" style="display: inline-block; padding: 12px 20px; border-radius: 12px; background-color: ${R.accent}; color: ${R.ink}; font-family: ${FONT}; font-size: 14px; font-weight: 600; text-decoration: none;">Open the factory</a>
    </td></tr>
  </table>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin: 0; padding: 0; background-color: ${R.ground}; font-family: ${FONT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${R.ground};"><tr><td align="center" style="padding: 32px 14px 40px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; background-color: ${R.card}; border: 1px solid ${R.line}; border-radius: 20px; overflow: hidden; box-shadow: 0 1px 2px rgba(17,17,19,0.04), 0 14px 34px rgba(17,17,19,0.07);">
      <tr><td style="padding: 15px 24px; background-color: ${R.band}; border-bottom: 1px solid ${R.line};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" style="width: 30px; height: 30px; background-color: ${R.ink}; color: ${R.card}; border-radius: 8px; text-align: center; font-family: ${FONT}; font-weight: 700; font-size: 14px;">h</td>
          <td valign="middle" style="padding: 0 0 0 11px; font-family: ${FONT}; font-weight: 600; font-size: 14px; color: ${R.ink};">Daily factory report</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding: 24px 24px 30px 24px;">${body}</td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px;"><tr><td align="center" style="padding: 22px 4px 0 4px; font-family: ${FONT}; font-size: 11px; color: ${R.inkMute}; line-height: 1.6;">
      <span style="font-weight: 700; color: ${R.inkSoft}; font-size: 12px;">hush<span style="color: ${R.accent};">.</span></span><br>Observability for your software factory. Times are UTC.
    </td></tr></table>
  </td></tr></table>
</body></html>`;

  const text = [`${headline} · ${label} · ${s.repo}`, "",
    `Automations: ${autoRuns.length} runs, ${missed.length} missed${tokens ? `, ${kn(tokens)} tokens` : ""}`,
    ...missed.map((a) => `  ! ${a.name} did not run`), ...degradedRuns.map((r) => `  ~ ${r.name}: ${r.note || r.status}`),
    `Costs: ${cd && cd.total > 0 ? usd(cd.total) + " spent" : "not in yet"}`,
    `Code: ${merged.length} PRs merged${pd ? `, +${pd.added || 0} −${pd.deleted || 0} lines` : ""}, ${promos.length} promotions`,
    `CI: ${mins(ciMin)}, ${ciRuns} runs, ${ciBad.length} workflows with failures`,
    `Issues: ${id?.opened ?? "?"} opened, ${id?.closed ?? "?"} closed, ${M?.issues?.open ?? "?"} open`,
    "", pageUrl].join("\n");

  return { day, subject: `${s.repo.split("/").pop()} · ${problems ? headline.toLowerCase() : "all clear"} · ${new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}`, html, text, needs: problems };
}

// The same day as data, for a repo's own report skill: every number with the day before beside it,
// so its template can show the change. Read with the repo's ingest key at GET /api/report.
export function reportData(s, { origin = "", day } = {}) {
  day = day || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const before = new Date(Date.parse(day + "T00:00:00Z") - 864e5).toISOString().slice(0, 10);
  const facts = (d) => {
    const on = (ts) => ts && String(ts).slice(0, 10) === d;
    const A = s.automations || [], dates = s.status?.daily?.dates || [], i = dates.indexOf(d);
    const runs = A.flatMap((a) => (a.runs || []).filter((r) => on(r.at)).map((r) => ({ name: a.name, status: r.status, note: r.note || "", tokens: Number(r.tokens || 0), usd: Number(r.usd || 0), secs: Number(r.secs || 0) })));
    const missed = A.filter((a) => !a.weekly && i >= 0 && a.buckets?.[a.buckets.length - dates.length + i]?.s === "miss").map((a) => a.name);
    const cd = s.costs?.per_day?.find((p) => p.d === d), pd = s.metrics?.prs?.per_day?.find((p) => p.d === d), id = s.metrics?.issues?.per_day?.find((p) => p.d === d);
    const merged = (s.queue?.merged || []).filter((p) => on(p.merged_at)), size = s.metrics?.prs?.size || {};
    const ci = (s.ci || []).map((w) => { const k = (w.dates || []).indexOf(d); return { name: w.name, mins: k >= 0 ? w.mins?.[k] || 0 : 0, ok: k >= 0 ? w.tips?.[k]?.ok || 0 : 0, bad: k >= 0 ? w.tips?.[k]?.bad || 0 : 0 }; });
    return {
      automations: { runs: runs.length, ok: runs.filter((r) => r.status === "ok").map((r) => r.name), degraded: runs.filter((r) => r.status !== "ok").map((r) => ({ name: r.name, note: r.note })), missed, tokens: runs.reduce((a, r) => a + r.tokens, 0), usd: Math.round(runs.reduce((a, r) => a + r.usd, 0) * 100) / 100, secs: runs.reduce((a, r) => a + r.secs, 0) },
      costs: cd ? { total: Math.round(cd.total * 100) / 100, by: Object.fromEntries(Object.entries(cd.by || {}).map(([k, v]) => [k, Math.round(v * 100) / 100])) } : null,
      code: { merged: pd?.all ?? merged.length, by_agents: pd?.agents ?? 0, added: pd?.added ?? 0, deleted: pd?.deleted ?? 0,
        opened: [...(s.queue?.prs || []), ...(s.queue?.merged || []), ...(s.queue?.closed || [])].filter((p) => on(p.created_at)).length,
        promotions: (s.promotions?.history || []).filter((p) => on(p.merged_at)).length,
        prs: merged.map((p) => ({ number: p.number, title: p.title, url: p.url, author: p.author || "", added: size[p.number]?.[0] ?? null, deleted: size[p.number]?.[1] ?? null })) },
      ci: { mins: Math.round(ci.reduce((a, w) => a + w.mins, 0)), runs: ci.reduce((a, w) => a + w.ok + w.bad, 0), failing: ci.filter((w) => w.bad).map((w) => ({ name: w.name, failed: w.bad, runs: w.ok + w.bad })) },
      issues: { opened: id?.opened ?? null, closed: id?.closed ?? null },
    };
  };
  const today = facts(day), prev = facts(before);
  const needs = (s.status?.groups || []).flatMap((g) => g.rows).filter((r) => ["dead", "degraded", "lying", "warn", "late"].includes(r.state)).map((r) => ({ skill: r.id, state: r.state }));
  return { repo: s.repo, day, before, url: `${origin}/r/${s.repo}`, generated_at: s.generated_at, open_issues: s.metrics?.issues?.open ?? null, needs, ...today, previous: prev,
    reports: (s.status?.reports || []).flatMap((r) => r.items.filter((x) => String(x.ts).slice(0, 10) === day).map((x) => ({ report: r.id, title: x.title || "", note: x.note || "" }))) };
}
