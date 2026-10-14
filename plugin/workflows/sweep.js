export const meta = {
  name: 'sweep',
  description: "Run the repo's Level 5 monitors now, try to refute every finding, and file only what survives",
  whenToUse: 'A monitor sweep on demand, with each finding checked by skeptics before it becomes an issue. Pass monitor ids to run only those.',
  phases: [
    { title: 'Roster', detail: 'the monitors in .claude/factory.json' },
    { title: 'Sweep', detail: 'one agent per monitor, nothing filed yet' },
    { title: 'Refute', detail: 'two skeptics per finding' },
    { title: 'File', detail: 'issues for what survived, then the heartbeat' },
  ],
}

// A routine runs a monitor on its own and files what it judges. A sweep runs the same skills, but
// every finding has to survive two agents whose job is to prove it wrong before it is filed:
// silence is the default output, so a false issue costs more than a missed one.

const ROSTER = {
  type: 'object',
  required: ['monitors'],
  properties: {
    monitors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'skill'],
        properties: { id: { type: 'string' }, skill: { type: 'string' }, volume_key: { type: 'string' } },
      },
    },
  },
}

const SWEPT = {
  type: 'object',
  required: ['status', 'swept', 'findings', 'note'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'skipped'] },
    swept: { type: 'object', additionalProperties: { type: 'number' } },
    note: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'body', 'evidence'],
        properties: {
          title: { type: 'string', description: "the issue title, in the skill's own title format" },
          body: { type: 'string', description: 'the issue body the skill would file' },
          evidence: { type: 'string', description: 'what was read that shows it: ids, counts, links, file:line' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['refuted', 'why'],
  properties: { refuted: { type: 'boolean' }, why: { type: 'string' } },
}

const FILED = {
  type: 'object',
  required: ['filed'],
  properties: { filed: { type: 'array', items: { type: 'number' } }, skipped: { type: 'array', items: { type: 'string' } } },
}

phase('Roster')
const only = Array.isArray(args) ? args : typeof args === 'string' && args.trim() ? args.trim().split(/[\s,]+/) : []
const roster = await agent(
  `Read .claude/factory.json and list its monitors whose skill exists at .claude/skills/<id>/SKILL.md. ` +
    `Leave out level5-report (a report, not a monitor) and any monitor that is a GitHub Actions workflow. ` +
    (only.length ? `Keep only these ids: ${only.join(', ')}. ` : '') +
    `Return each with its id, the skill path, and its volume_key. No .claude/factory.json: return no monitors.`,
  { schema: ROSTER, effort: 'low' },
)

if (!roster || !roster.monitors.length) {
  log('No monitors to run. /level5:setup builds them, /level5:new-monitor adds one.')
  return { monitors: [] }
}
log(`${roster.monitors.length} monitor${roster.monitors.length === 1 ? '' : 's'}: ${roster.monitors.map(m => m.id).join(', ')}`)

const results = await pipeline(
  roster.monitors,
  m =>
    agent(
      `Run the monitor in ${m.skill} as written, with two changes: do NOT create, comment on or close any ` +
        `GitHub issue, and do NOT send its heartbeat. Instead, return what it would have filed, each with the ` +
        `evidence you read that shows it, plus the status and the counts (swept) it would have sent. ` +
        `Do its dedupe step: leave out anything already open. A credential it needs is missing: status skipped, no findings.`,
      { label: `sweep:${m.id}`, phase: 'Sweep', schema: SWEPT },
    ),
  (run, m) => {
    if (!run) return null
    return parallel(
      run.findings.map(f => () =>
        parallel(
          ['the data: re-read the source and check every number and id in the evidence', 'the judgment: is this new, real and worth a person reading it, or noise the skill should have suppressed'].map(
            (lens, i) => () =>
              agent(
                `A monitor (${m.id}) wants to file this issue. Try to prove it wrong, through ${lens}. ` +
                  `Default to refuted=true if you cannot confirm it.\n\nTitle: ${f.title}\n\nEvidence: ${f.evidence}\n\nBody:\n${f.body}`,
                { label: `refute:${m.id}:${i}`, phase: 'Refute', schema: VERDICT },
              ),
          ),
        ).then(votes => ({ ...f, survives: votes.filter(Boolean).filter(v => !v.refuted).length === 2, votes })),
      ),
    ).then(judged => ({ ...run, judged: judged.filter(Boolean) }))
  },
  (run, m) => {
    if (!run) return null
    const keep = run.judged.filter(f => f.survives)
    return agent(
      `File these issues the way ${m.skill} files them (its label, its title format, its dedupe check right ` +
        `before each), then send its heartbeat with .claude/hooks/level5.sh exactly as the skill's last step says, ` +
        `with status ${run.status}, swept ${JSON.stringify(run.swept)}, the issue numbers you filed, and the note ` +
        `"sweep: ${run.judged.length - keep.length} refuted. ${run.note.replace(/"/g, "'")}". ` +
        `Return the numbers filed, and the titles you skipped as already open.\n\n` +
        (keep.length ? keep.map(f => `Title: ${f.title}\nBody:\n${f.body}`).join('\n\n---\n\n') : 'Nothing to file: only send the heartbeat.'),
      { label: `file:${m.id}`, phase: 'File', schema: FILED, effort: 'low' },
    ).then(filed => ({
      monitor: m.id,
      status: run.status,
      swept: run.swept,
      filed: filed ? filed.filed : [],
      refuted: run.judged.filter(f => !f.survives).map(f => ({ title: f.title, why: f.votes.filter(Boolean).filter(v => v.refuted).map(v => v.why) })),
    }))
  },
)

return { monitors: results.filter(Boolean) }
