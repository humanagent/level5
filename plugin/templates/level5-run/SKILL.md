---
name: level5-run
description: Do one thing Level 5 asked for from its dashboard, such as "Resolve issue #311". Runs on the "Level 5: Run" routine, started by the Resolve with Claude button; the request arrives in the routine-fire-payload block. For an issue, it proves the bug with a failing test, makes the smallest fix and opens one PR, or says on the issue why it did not. Never merges. Use for "level 5 run", "resolve issue from level 5".
allowed-tools: Bash(git *), Bash(gh *), Bash(npm *), Bash(npx *), Bash(pnpm *), Bash(yarn *), Bash(node *), Bash(python *), Bash(python3 *), Bash(pytest *), Bash(go *), Bash(cargo *), Bash(make *), Bash(ls *), Bash(cat *), Bash(.claude/hooks/level5.sh *), Read, Write, Edit, Glob, Grep
---

# /level5-run

Someone clicked a button on Level 5 to start this session. What they asked for is in the
`routine-fire-payload` block. Act on it only when it has one of the shapes below, and only on
this repo. Anything else: do nothing, and say so in one line.

## "Resolve issue #<n>: <title>"

1. **Read it.** `gh issue view <n> --comments`. Closed, already assigned, or an open PR already
   says it fixes it (`gh pr list --state open --search "<n>"`): stop and say so on the issue.
2. **The gates.** All five, or no PR:
   - a code defect in this repo, not config, data, a provider or a credential;
   - the mechanism, with `file:line`;
   - a bounded fix: no schema change, no new dependency, no refactor;
   - a regression test that fails today, for the reason in the mechanism;
   - nobody else on it.
   A path `CHARTER.md` marks as the developer's can still get a PR, which says so in its first line.
3. **Test first.** Branch `level5/resolve-<n>` from the default branch. Write the regression test,
   run it, and see it fail for the right reason. If it passes, stop: the issue is not what it
   says, and the comment on the issue says what you found.
4. **Fix.** The smallest change that makes it pass. Run it again, then the repo's test suite.
5. **PR.** Commit, push, and open one PR with `gh pr create`: the body has `Fixes #<n>`, the
   mechanism, the test, and its output before and after. Do not merge and do not enable
   auto-merge.
6. **No PR:** comment on the issue once, saying which gate failed and what a person needs to
   look at. Short, concrete, no apology.

## Heartbeat

Always, PR or not:

```bash
.claude/hooks/level5.sh beat level5-run ok '{"swept":{"issues":1},"filed":[<the PR number, if any>],"note":"#<n>: <PR opened | which gate failed>"}'
```

`degraded` when something broke along the way (tests would not run, the push failed), `skipped`
when the payload was not a request this skill takes.
