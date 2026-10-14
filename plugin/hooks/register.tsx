// Type V inside the session: a band above the prompt when a monitor needs a look, a toast when the
// session starts with one, and /typev for the repo's state on demand. It reads the repo's summary
// from Type V with the same key the routines post with (.claude/typev.json, the routine's
// environment, or the plugin's own setting), every 15 minutes. Silence is the default: with
// everything fine the band draws nothing.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Need, Summary } from '../types'

const summary = atom({ plugin: 'typev', key: 'summary' } as const, null)
const problem = atom({ plugin: 'typev', key: 'problem' } as const, null)
const isHidden = atom({ plugin: 'typev', key: 'isHidden' } as const, false)

const DEFAULT_URL = 'https://factory-status.fly.dev'
const EVERY = 15 * 60e3

// the same words Pulse files its issues with
const SAY: Record<string, string> = {
  dead: 'stopped',
  late: 'missed its last run',
  degraded: 'is chronically degraded',
  lying: 'said ok after reading nothing',
  warn: 'came back degraded',
}
export const say = (n: Need) => `${n.skill} ${SAY[n.state] ?? 'needs a look'}`

const usd = (n: number | null) => (n == null ? null : '$' + n.toFixed(2))

type Conn = { url: string; key: string }

async function connection($: EngineInterface, key: string): Promise<Conn | null> {
  let file: { url?: string; key?: string } = {}
  try {
    file = JSON.parse(await $.fs.read('.claude/typev.json'))
  } catch {}
  const url = (await $.env.get('TYPEV_URL')) || file.url || DEFAULT_URL
  const k = (await $.env.get('TYPEV_KEY')) || file.key || key
  return k ? { url: url.replace(/\/+$/, ''), key: k } : null
}

// GET /api/report: the summary of this repo the key may read
export function toSummary(d: any): Summary {
  return {
    repo: String(d.repo ?? ''),
    url: String(d.url ?? ''),
    day: String(d.day ?? ''),
    needs: Array.isArray(d.needs) ? d.needs.map((n: any) => ({ skill: String(n.skill), state: String(n.state) })) : [],
    missed: d.automations?.missed ?? [],
    failing: (d.ci?.failing ?? []).map((w: any) => String(w.name)),
    runs: Number(d.automations?.runs ?? 0),
    usd: d.costs?.total ?? null,
  }
}

async function refresh($: EngineInterface, key: string): Promise<Summary | null> {
  const conn = await connection($, key)
  if (!conn) {
    await update($, summary, () => null)
    await update($, problem, () => null)
    return null
  }
  try {
    const r = await $.http.fetch(`${conn.url}/api/report`, { headers: { authorization: `Bearer ${conn.key}` } })
    if (!r.ok) throw new Error(r.status === 401 ? 'the ingest key was refused' : `Type V answered ${r.status}`)
    const s = toSummary(JSON.parse(r.text))
    await update($, summary, () => s)
    await update($, problem, () => null)
    return s
  } catch (err) {
    await update($, problem, () => (err instanceof Error ? err.message : String(err)))
    return null
  }
}

export function describe(s: Summary | null, why: string | null): string {
  if (!s) {
    return why
      ? `Type V could not read this repo: ${why}.`
      : 'This repo is not connected to Type V. Run /typev:setup <ingest-key>, with the key from the repo\'s page on Type V.'
  }
  const lines = [s.needs.length ? `${s.repo}: ${s.needs.length} need${s.needs.length === 1 ? 's' : ''} a look` : `${s.repo}: all clear`]
  for (const n of s.needs) lines.push(`  ${say(n)}`)
  const day = [`${s.runs} run${s.runs === 1 ? '' : 's'}`]
  if (s.missed.length) day.push(`missed: ${s.missed.join(', ')}`)
  if (s.failing.length) day.push(`CI failing: ${s.failing.join(', ')}`)
  if (s.usd != null) day.push(`${usd(s.usd)} spent`)
  lines.push(`${s.day}: ${day.join(' · ')}`)
  if (s.url) lines.push(s.url)
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const band = String(options.band ?? 'problems')
  const key = String(options.key ?? '')

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'typev', description: 'What Type V says about this repo now' })
    const s = await refresh($, key)
    if (s?.needs.length && band !== 'off') {
      $.ui.toast(`Type V: ${s.needs.length} need${s.needs.length === 1 ? 's' : ''} a look. /typev`, { timeoutMs: 6000 })
    }
    $.clock.every(EVERY, () => void refresh($, key))
    return next(e)
  })

  on('command.run', { command: 'typev' }, async $ => {
    await update($, isHidden, () => false)
    const s = await refresh($, key)
    return { text: describe(s, await read($, problem)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (band === 'off' || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const s = await read($, summary)
    if (!s || (!s.needs.length && band !== 'always')) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.viewport?.columns ?? 100
    const first = s.needs.slice(0, width >= 120 ? 2 : 1).map(say).join(' · ')
    const more = s.needs.length > 2 || (width < 120 && s.needs.length > 1) ? ` +${s.needs.length - (width >= 120 ? 2 : 1)}` : ''

    return (
      <Box>
        <Text bold>Type V </Text>
        {s.needs.length ? (
          <Text color="warning">{`${first}${more} `}</Text>
        ) : (
          <Text dimColor>{`all clear${s.usd != null ? ` · ${usd(s.usd)} yesterday` : ''} `}</Text>
        )}
        <Text dimColor>/typev </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
