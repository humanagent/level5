import { describe as group, expect, mock, test } from 'claude-code/testing'

import { describe, say, toSummary } from './register'

const DAY = {
  repo: 'acme/shop',
  url: 'https://factory-status.fly.dev/r/acme/shop',
  day: '2026-10-13',
  needs: [
    { skill: 'level5-report', state: 'late' },
    { skill: 'level5-monitor-errors', state: 'lying' },
  ],
  automations: { runs: 3, missed: ['Level 5: Report'] },
  ci: { failing: [{ name: 'deploy', failed: 1, runs: 4 }] },
  costs: { total: 4.2 },
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// the kit fills origin and presentation as a typed command does
const LEVEL5 = { command: 'level5' } as never

group('summary', () => {
  test('reads the report the key may read', async () => {
    const s = toSummary(DAY)
    expect(s.needs).toHaveLength(2)
    expect(s.failing).toEqual(['deploy'])
    expect(say(s.needs[1]!)).toBe('level5-monitor-errors said ok after reading nothing')
    const text = describe(s, null)
    expect(text).toContain('acme/shop: 2 need a look')
    expect(text).toContain('level5-report missed its last run')
    expect(text).toContain('CI failing: deploy')
    expect(text).toContain('$4.20 spent')
  })

  test('says how to connect a repo that is not', async () => {
    expect(describe(null, null)).toContain('/level5:setup')
    expect(describe(null, 'the ingest key was refused')).toContain('refused')
  })
})

test('/level5 reads the repo and the band shows what needs a look', async ($, on) => {
  mock.env(on, {})
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
  on('fs.read', async () => ({ value: JSON.stringify({ url: 'https://tv.test', key: 'fsk_test' }) }))
  const asked: string[] = []
  on('http.fetch', async (_$, e) => {
    asked.push(`${e.url} ${e.init?.headers?.authorization}`)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(DAY) } }
  })

  const { text } = await $.command.run(LEVEL5)
  expect(asked).toEqual(['https://tv.test/api/report Bearer fsk_test'])
  expect(text).toContain('2 need a look')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'level5', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /missed its last run/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'level5', surface: 'terminal', ...BAND })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /missed its last run/ })).toBeUndefined()
  await ui.unmount()
})

test('the band stays silent when all is clear', async ($, on) => {
  mock.env(on, {})
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
  on('fs.read', async () => ({ value: JSON.stringify({ key: 'fsk_test' }) }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...DAY, needs: [] }) } }))
  const { text } = await $.command.run(LEVEL5)
  expect(text).toContain('all clear')
  const ui = await $.ui.mount({ plugin: 'level5', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Level 5/ })).toBeUndefined()
  await ui.unmount()
})
