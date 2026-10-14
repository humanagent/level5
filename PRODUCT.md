# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

A single self-contained HTML page (`index.html`), published as a claude.ai artifact at
https://claude.ai/artifact/C4rJUkNJ6pQwyEUMoAsbrR. No build step, no framework. Confirmed 2026-10-10
("same artifact").

## Users

A solo developer or a small team that ships with Claude Code and has nobody watching production
dashboards. They want to hear about production only when something is really broken, and they want
the obvious fixes to happen without them.

## Product Purpose

Level 5 is a Claude Code plugin that watches production. Monitors read errors, logs, costs and LLM
traces on a schedule, stay silent when things are fine, and open a GitHub issue when something is
really broken. A fixer takes the issues it can prove and opens a PR with a regression test. Success
is a developer who stops opening dashboards because the important problems arrive as issues and
the small ones arrive already fixed.

## Positioning

Two mechanisms, confirmed as the differentiators:

1. **The monitor of the monitors (Pulse).** Every monitor leaves a heartbeat when it finishes, and
   Pulse checks them against a roster on its own schedule. It files when a monitor is dead, or when
   it reported ok after reading nothing. A dead monitor and a healthy system both look like silence;
   nothing else on the market packages this check.
2. **It closes the loop.** Production, issue, fix, PR, with a human in the loop only where the
   developer says (paths marked as theirs never merge on their own).

Neighbors for reference: complete "software factory" plugins (jfa94/factory, eski009/Factory,
genai-jerry/claude-software-factory, addyosmani/factory) stop before production; the Sentry plugin
reads one source on demand; Heartbeat alerts on thresholds without filing or fixing.

## Operating Context

- Runs inside Claude Code as a plugin (skills, agents, hooks), on a schedule (routines or cron).
- GitHub is the queue: issues in, PRs out.
- Setup writes a short `CHARTER.md` to the target repo: which sources exist, which paths stay the
  developer's.
- Command names on the current mock (`/watch`, `/mend`, `/pulse`, `/level5 setup`) are working names.

## Capabilities and Constraints

- Monitors per source: errors, logs, cost, LLM traces, delivery, speed (the set on the mock).
- Fixer gates: a code defect in this repo, a mechanism with `file:line`, a bounded fix (no schema
  change, no new dependency, no refactor), a regression test that fails without the fix, nobody
  else on it.
- The name is Level 5, after the levels of driving autonomy: at level 0 you watch every
  dashboard, at level 5 the repo's automations watch themselves and you hear only what is broken. **Open:** the repo account
  (`humanagent` proposed), license (MIT shown on the mock) and Codex support are undecided.
- The plugin does not exist yet; only the landing does.

## Brand Commitments

- All copy written in the author's voice: never an em-dash, short, flat, concrete nouns, no
  corporate abstraction, numbers over adjectives.
- Fully abstract: the product must not name, describe or hint at the private production system it
  was derived from (no product name, no domain nouns, no PR counts or dates from it).

## Evidence on Hand

None public. Every number, issue (#418), roster row and log line on the current page is invented
example data and is labelled as such. Do not fabricate users, testimonials, star counts, customer
logos or benchmarks.

## Product Principles

1. Silence is the default output. Every message the developer gets must be worth reading.
2. Prove before acting: no fix without a mechanism and a failing test.
3. The developer owns the risky paths; the agent never widens its own scope.
4. Watch the watchers. A monitor that stopped is a bug.
