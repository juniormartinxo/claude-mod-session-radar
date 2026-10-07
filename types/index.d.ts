export type RadarStatus = 'busy' | 'waiting' | 'idle' | 'unknown'

export type RadarSession = {
  pid: number
  sessionId: string
  name: string
  cwd: string
  status: RadarStatus
  waitingFor?: string
  startedAt: number
  changedAt: number
  version: string
  entrypoint: string
  profile: string
  rssMb?: number
  cpu?: number
  isSelf: boolean
  canMessage: boolean
  lastPrompt?: string
  lastPromptAt?: number
  model?: string
  ctxTokens?: number
  ctxWindow?: number
  isWindowGuessed?: boolean
  spentTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  uncached?: number
  cacheTtlMs?: number
  lastResponseAt?: number
}

export type RadarLimit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-radar': {
      sessions: RadarSession[]
      scannedAt: number
      pulse: boolean
      notify: boolean
      composeTo: string
      darkBg: boolean
      limits: RadarLimit[]
    }
  }
}
