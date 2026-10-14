// What the mod keeps in $.state: the repo's last summary from Type V, and whether the band is hidden.

export type Need = { skill: string; state: string }

export type Summary = {
  repo: string
  url: string
  day: string
  needs: Need[]
  missed: string[]
  failing: string[]
  runs: number
  usd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    typev: { summary: Summary | null; problem: string | null; isHidden: boolean }
  }
}
