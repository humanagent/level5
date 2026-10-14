export const meta = {
  name: 'mend',
  description: 'Fix the Level 5 issues that can be proven: a failing regression test first, then a bounded fix, one PR each',
  whenToUse: 'Turn open level5:* issues into PRs. Pass issue numbers to take only those. Never merges.',
  phases: [
    { title: 'Queue', detail: 'open level5 issues nobody is on' },
    { title: 'Gate', detail: 'is it a bounded code defect in this repo' },
    { title: 'Fix', detail: 'test that fails, fix, PR; each in its own worktree' },
    { title: 'Check', detail: 'a skeptic re-runs the test without the fix' },
  ],
}

// The fixer's gates, all five or no PR: a code defect in this repo; a mechanism with file:line;
// a bounded fix (no schema change, no new dependency, no refactor); a regression test that fails
// without the fix; nobody else on it. Paths the CHARTER.md marks as the developer's get a PR that
// says so and is never auto-merged. It opens PRs and stops there.

const QUEUE = {
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: { type: 'object', required: ['number', 'title'], properties: { number: { type: 'number' }, title: { type: 'string' }, url: { type: 'string' } } },
    },
  },
}

const GATE = {
  type: 'object',
  required: ['fixable', 'reason'],
  properties: {
    fixable: { type: 'boolean' },
    reason: { type: 'string', description: 'which gate failed, or why all five hold' },
    mechanism: { type: 'string', description: 'file:line and what goes wrong there' },
    plan: { type: 'string', description: 'the test that will fail, and the smallest change that makes it pass' },
    owned: { type: 'boolean', description: 'the fix touches a path CHARTER.md marks as the developer\'s' },
  },
}

const FIX = {
  type: 'object',
  required: ['opened', 'note'],
  properties: {
    opened: { type: 'boolean' },
    pr: { type: 'number' },
    url: { type: 'string' },
    branch: { type: 'string' },
    test: { type: 'string', description: 'the command that runs the regression test alone' },
    note: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['holds', 'why'],
  properties: { holds: { type: 'boolean' }, why: { type: 'string' } },
}

phase('Queue')
const only = Array.isArray(args) ? args.map(Number) : typeof args === 'string' && args.trim() ? args.trim().split(/[\s,#]+/).filter(Boolean).map(Number) : []
const queue = await agent(
  only.length
    ? `Return GitHub issues ${only.join(', ')} of this repo (gh issue view), leaving out any that is closed.`
    : `List the open GitHub issues of this repo with a level5:* label (gh issue list --state open --json number,title,labels,assignees,url --limit 100), ` +
        `leaving out level5:report and level5:pulse (they are not code), any issue with an assignee, and any issue an open PR already references ` +
        `(gh pr list --state open --search "<number>").`,
  { schema: QUEUE, effort: 'low' },
)
if (!queue || !queue.issues.length) {
  log('Nothing to mend.')
  return { prs: [], declined: [] }
}
log(`${queue.issues.length} issue${queue.issues.length === 1 ? '' : 's'}: ${queue.issues.map(i => '#' + i.number).join(' ')}`)

const results = await pipeline(
  queue.issues,
  issue =>
    agent(
      `Read issue #${issue.number} (gh issue view ${issue.number} --comments) and the code it points at. Decide whether all five gates hold: ` +
        `1) a code defect in this repo, not a config, data, provider or credential problem; 2) you can name the mechanism with file:line; ` +
        `3) the fix is bounded: no schema change, no new dependency, no refactor; 4) a regression test can be written that fails today; ` +
        `5) nobody else is on it (no assignee, no open PR, no comment saying someone is). Read CHARTER.md if there is one and say whether the fix ` +
        `touches a path it marks as the developer's. Read only; change nothing.`,
      { label: `gate:#${issue.number}`, phase: 'Gate', schema: GATE },
    ),
  (gate, issue) => {
    if (!gate || !gate.fixable) return { issue: issue.number, declined: gate ? gate.reason : 'the gate agent did not answer' }
    return agent(
      `Fix issue #${issue.number}: ${issue.title}\n\nMechanism: ${gate.mechanism}\nPlan: ${gate.plan}\n\n` +
        `Work on a new branch level5/mend-${issue.number} from the default branch. In this order: write the regression test; run it and see it fail ` +
        `for the reason in the mechanism (if it passes, stop: opened=false, and say so); make the smallest change that makes it pass; run it again, ` +
        `then the repo's test suite. Stay inside the plan: no schema change, no new dependency, no refactor, no unrelated edit. ` +
        `Commit, push, and open a PR with gh whose body has "Fixes #${issue.number}", the mechanism, the test and its output before and after` +
        (gate.owned ? `, and a first line saying it touches a path CHARTER.md marks as the developer's, so it needs their review` : '') +
        `. Do not merge, do not enable auto-merge. Return the PR number and url, the branch, and the command that runs the test alone.`,
      { label: `fix:#${issue.number}`, phase: 'Fix', schema: FIX, isolation: 'worktree' },
    ).then(fix => ({ issue: issue.number, gate, fix }))
  },
  r => {
    if (!r || r.declined || !r.fix || !r.fix.opened) return r
    return agent(
      `PR #${r.fix.pr} (branch ${r.fix.branch}) claims to fix issue #${r.issue} with a regression test (${r.fix.test}). Try to prove the claim wrong. ` +
        `Check out the PR's branch, revert only the non-test changes (git diff against its base), run the test and confirm it FAILS; restore and confirm it ` +
        `PASSES. Read the diff for anything past the plan: a schema change, a new dependency, a refactor, an edit unrelated to the mechanism. ` +
        `holds=false if the test passes without the fix, fails with it, or the diff goes past the plan. If holds=false, mark the PR as draft ` +
        `(gh pr ready ${r.fix.pr} --undo) and comment why. Leave the working tree as you found it.`,
      { label: `check:#${r.issue}`, phase: 'Check', schema: VERDICT, isolation: 'worktree' },
    ).then(v => ({ ...r, check: v }))
  },
)

const done = results.filter(Boolean)
return {
  prs: done.filter(r => r.fix && r.fix.opened).map(r => ({ issue: r.issue, pr: r.fix.pr, url: r.fix.url, holds: r.check ? r.check.holds : null, why: r.check ? r.check.why : '' })),
  declined: done.filter(r => r.declined || (r.fix && !r.fix.opened)).map(r => ({ issue: r.issue, why: r.declined || r.fix.note })),
}
