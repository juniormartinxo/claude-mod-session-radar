import { atom, read, update } from 'claude-code'
import type { BoxProps, ElementConstructor, EngineInterface, Register, TextProps } from 'claude-code'

import type { RadarLimit, RadarSession, RadarStatus } from '../types'

const PANE = 'session-radar'
const TITLE = 'Radar'
const SCAN_MS = 2000
const CLK_TCK = 100
const HISTORY_READ_MAX = 3_500_000

const sessions = atom({ plugin: 'session-radar', key: 'sessions' } as const, [])
const scannedAt = atom({ plugin: 'session-radar', key: 'scannedAt' } as const, 0)
const pulse = atom({ plugin: 'session-radar', key: 'pulse' } as const, false)
const notify = atom({ plugin: 'session-radar', key: 'notify' } as const, true)
// The sessionId whose message field is open; '' when none.
const composeTo = atom({ plugin: 'session-radar', key: 'composeTo' } as const, '')
// Paint the pane's own background: the dock's tint is light. Kept across sessions in $.store.
const darkBg = atom({ plugin: 'session-radar', key: 'darkBg' } as const, true)
const DARK_BG = 'black'
// The account's usage windows as the last API response of this session reported them.
const limits = atom({ plugin: 'session-radar', key: 'limits' } as const, [])
const HEARTS = 5
const LIMIT_ROWS = [
  { kind: 'five_hour', label: '5h', color: 'yellow', withDate: false },
  { kind: 'seven_day', label: '7d', color: 'red', withDate: true },
] as const
// Wide enough for "[4d 15h] 09/10 10:00", so both rows' hearts line up.
const RESET_WIDTH = 20
// Breathing room between the pane's edges and its content, in cells.
const PAD_X = 2
const PAD_Y = 1

type RawSession = {
  pid?: number
  sessionId?: string
  cwd?: string
  name?: string
  status?: string
  waitingFor?: string
  startedAt?: number
  updatedAt?: number
  statusUpdatedAt?: number
  procStart?: string
  version?: string
  entrypoint?: string
  messagingSocketPath?: string
}

type ConfigDir = { dir: string; profile: string }

// Cache of parsed session files by path, refreshed only when mtime changes.
const fileCache = new Map<string, { mtimeMs: number; raw: RawSession | undefined }>()
// Previous CPU ticks per pid, to turn cumulative ticks into a percentage.
const cpuPrev = new Map<number, { ticks: number; at: number }>()
// Last prompt per session, per history.jsonl, kept until the file changes.
const historyCache = new Map<string, { mtimeMs: number; size: number; last: Map<string, LastPrompt> }>()
// Previous status per session, to notice transitions worth a toast.
let lastStatus: Map<string, RadarStatus> | undefined
let selfId = ''
let home = ''
let configOverride: string | undefined
let isScanning = false
// What is typed in the message field, kept outside $.state so typing redraws nothing.
let draft = ''
// The host's UTC offset in minutes (`date +%z`): this module's own clock may run in UTC.
let utcOffsetMin = -new Date().getTimezoneOffset()

const STATUS_ORDER: Record<RadarStatus, number> = { waiting: 0, busy: 1, idle: 2, unknown: 3 }

const STATUS_LABEL: Record<RadarStatus, string> = {
  busy: 'trabalhando',
  waiting: 'aguardando você',
  idle: 'ociosa',
  unknown: 'desconhecido',
}

const STATUS_COLOR: Record<RadarStatus, string> = {
  busy: 'green',
  waiting: 'yellow',
  idle: 'gray',
  unknown: 'gray',
}

const ENTRYPOINT_LABEL: Record<string, string> = {
  cli: 'terminal',
  'sdk-cli': 'app',
  'sdk-ts': 'sdk',
  'sdk-py': 'sdk',
}

function toStatus(raw: string | undefined): RadarStatus {
  return raw === 'busy' || raw === 'waiting' || raw === 'idle' ? raw : 'unknown'
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 10) return 'agora'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function tildify(path: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function fit(text: string, width: number): string {
  if (text.length <= width) return text
  return width <= 1 ? text.slice(0, width) : `…${text.slice(text.length - width + 1)}`
}

// Keeps the start of the text (a prompt reads left to right).
function cut(text: string, width: number): string {
  if (text.length <= width) return text
  return width <= 1 ? text.slice(0, Math.max(0, width)) : `${text.slice(0, width - 1)}…`
}

async function configDirs($: EngineInterface): Promise<ConfigDir[]> {
  const found: ConfigDir[] = [{ dir: `${home}/.claude`, profile: 'padrão' }]
  const profilesRoot = `${home}/.config/cloak/profiles`
  const profiles = await $.fs.list(profilesRoot).catch(() => [])
  for (const entry of profiles) {
    if (entry.kind === 'dir') {
      found.push({ dir: `${profilesRoot}/${entry.name}/claude`, profile: entry.name })
    }
  }
  if (configOverride && !found.some(one => one.dir === configOverride)) {
    found.push({ dir: configOverride, profile: configOverride.split('/').slice(-1)[0] ?? 'custom' })
  }

  return found
}

async function readRaw($: EngineInterface, path: string, mtimeMs: number) {
  const cached = fileCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.raw
  const raw = await $.fs
    .read(path)
    .then(text => JSON.parse(text) as RawSession)
    .catch(() => undefined)
  fileCache.set(path, { mtimeMs, raw })

  return raw
}

type LastPrompt = { text: string; at: number }

// Each profile's history.jsonl holds every prompt typed, one JSON line each,
// tagged with its sessionId: re-parsed only when the file changes. Past what
// one $.fs.read copies (4 MiB), only the file's tail is read.
async function lastPrompts($: EngineInterface, dir: string): Promise<Map<string, LastPrompt>> {
  const path = `${dir}/history.jsonl`
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return new Map()
  const cached = historyCache.get(path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.last

  const text =
    stat.size <= HISTORY_READ_MAX
      ? await $.fs.read(path).catch(() => '')
      : await $.process
          .run(['tail', '-c', String(HISTORY_READ_MAX), path], { timeoutMs: 5000 })
          .then(run => run.stdout.slice(run.stdout.indexOf('\n') + 1))
          .catch(() => '')

  const last = new Map<string, LastPrompt>()
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line) as { display?: string; timestamp?: number; sessionId?: string }
      if (row.sessionId && row.display?.trim()) {
        last.set(row.sessionId, { text: row.display.replace(/\s+/g, ' ').trim(), at: row.timestamp ?? 0 })
      }
    } catch {
      // a line cut mid-write: skip it
    }
  }
  historyCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, last })

  return last
}

type Tally = {
  offset: number
  // Final usage per API message: one response is several transcript rows.
  byId: Map<string, { read: number; write: number; uncached: number; output: number }>
  ctx?: number
  model?: string
  // When the main thread last got a response, and the cache lifetime it wrote under.
  lastAt?: number
  ttlMs?: number
}

const CACHE_TTL_5M = 5 * 60_000
const CACHE_TTL_1H = 60 * 60_000

const tallies = new Map<string, Tally>()
// The context window the engine reports for this session's model, reused
// for other sessions on the same model.
const windowByModel = new Map<string, number>()
const encoder = new TextEncoder()
const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// Reads only the bytes appended since the last scan (tail -c +offset), up to
// the last complete line, so a transcript of any size costs one read once.
async function tallyTranscript($: EngineInterface, path: string): Promise<Tally | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return undefined
  let tally = tallies.get(path)
  if (!tally || stat.size < tally.offset) {
    tally = { offset: 0, byId: new Map() }
    tallies.set(path, tally)
  }

  for (let round = 0; tally.offset < stat.size && round < 8; round++) {
    const run = await $.process
      .run(['tail', '-c', `+${tally.offset + 1}`, path], { timeoutMs: 10_000 })
      .catch(() => undefined)
    if (!run || run.exitCode !== 0) break
    const end = run.stdout.lastIndexOf('\n')
    if (end < 0) break
    const chunk = run.stdout.slice(0, end + 1)
    tally.offset += encoder.encode(chunk).length

    for (const line of chunk.split('\n')) {
      if (!line.includes('"type":"assistant"')) continue
      let row: {
        isSidechain?: boolean
        timestamp?: string
        message?: {
          id?: string
          model?: string
          usage?: Record<string, unknown>
        }
      }
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const usage = row.message?.usage
      const id = row.message?.id
      if (!usage || !id || row.message?.model === '<synthetic>') continue
      const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
      const read = n('cache_read_input_tokens')
      const write = n('cache_creation_input_tokens')
      const uncached = n('input_tokens')
      tally.byId.set(id, { read, write, uncached, output: n('output_tokens') })
      if (!row.isSidechain) {
        tally.ctx = read + write + uncached
        tally.model = row.message?.model
        const at = row.timestamp ? Date.parse(row.timestamp) : NaN
        if (Number.isFinite(at)) tally.lastAt = at
        const split = usage.cache_creation as Record<string, unknown> | undefined
        if (Number(split?.ephemeral_1h_input_tokens) > 0) tally.ttlMs = CACHE_TTL_1H
        else if (Number(split?.ephemeral_5m_input_tokens) > 0) tally.ttlMs = CACHE_TTL_5M
      }
    }
    if (!run.isStdoutTruncated) break
  }

  return tally
}

function tokens(n: number): string {
  const short =
    n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`

  return short.replace('.0', '').replace('.', ',')
}

// A session file outlives a crashed process, so the pid must be alive AND
// have the same start time the session recorded (pids get reused).
async function probeProcess($: EngineInterface, pid: number, procStart: string | undefined, now: number) {
  const stat = await $.fs.read(`/proc/${pid}/stat`).catch(() => undefined)
  if (stat === undefined) return undefined
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  if (procStart !== undefined && fields[19] !== procStart) return undefined

  const ticks = Number(fields[11]) + Number(fields[12])
  const prev = cpuPrev.get(pid)
  cpuPrev.set(pid, { ticks, at: now })
  const cpu =
    prev && now > prev.at ? Math.max(0, ((ticks - prev.ticks) / CLK_TCK / ((now - prev.at) / 1000)) * 100) : undefined

  const status = await $.fs.read(`/proc/${pid}/status`).catch(() => '')
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN)

  return { cpu, rssMb: Number.isFinite(rssKb) ? Math.round(rssKb / 1024) : undefined }
}

type OwnUsage = Awaited<ReturnType<EngineInterface['session']['usage']>>

async function scan($: EngineInterface, ownUsage: OwnUsage | undefined): Promise<RadarSession[]> {
  const now = await $.clock.now()
  const out: RadarSession[] = []
  const seen = new Set<string>()

  for (const { dir, profile } of await configDirs($)) {
    const entries = await $.fs.list(`${dir}/sessions`).catch(() => [])
    if (entries.length === 0) continue
    const prompts = await lastPrompts($, dir)
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const raw = await readRaw($, `${dir}/sessions/${entry.name}`, entry.mtimeMs)
      if (!raw?.pid || !raw.sessionId || seen.has(raw.sessionId)) continue
      const proc = await probeProcess($, raw.pid, raw.procStart, now)
      if (!proc) continue
      seen.add(raw.sessionId)
      const isSelf = raw.sessionId === selfId
      const tally = raw.cwd
        ? await tallyTranscript($, `${dir}/projects/${projectSlug(raw.cwd)}/${raw.sessionId}.jsonl`)
        : undefined
      const own = isSelf ? ownUsage : undefined
      if (own && tally?.model) windowByModel.set(tally.model, own.context.window)
      const ctxTokens = own?.context.tokens ?? tally?.ctx
      const knownWindow = own?.context.window ?? (tally?.model ? windowByModel.get(tally.model) : undefined)
      const ctxWindow = knownWindow ?? ((ctxTokens ?? 0) > DEFAULT_WINDOW ? LARGE_WINDOW : DEFAULT_WINDOW)
      let outputTokens = 0
      let cacheRead = 0
      let cacheWrite = 0
      let uncached = 0
      for (const one of tally?.byId.values() ?? []) {
        outputTokens += one.output
        cacheRead += one.read
        cacheWrite += one.write
        uncached += one.uncached
      }
      const spentTokens = cacheRead + cacheWrite + uncached + outputTokens
      out.push({
        pid: raw.pid,
        sessionId: raw.sessionId,
        name: raw.name ?? raw.cwd?.split('/').slice(-1)[0] ?? String(raw.pid),
        cwd: raw.cwd ?? '?',
        status: toStatus(raw.status),
        waitingFor: raw.waitingFor,
        startedAt: raw.startedAt ?? now,
        changedAt: raw.statusUpdatedAt ?? raw.updatedAt ?? raw.startedAt ?? now,
        version: raw.version ?? '?',
        entrypoint: ENTRYPOINT_LABEL[raw.entrypoint ?? ''] ?? raw.entrypoint ?? '?',
        profile,
        rssMb: proc.rssMb,
        cpu: proc.cpu,
        isSelf,
        canMessage: Boolean(raw.messagingSocketPath),
        lastPrompt: prompts.get(raw.sessionId)?.text,
        lastPromptAt: prompts.get(raw.sessionId)?.at,
        model: tally?.model?.replace(/^claude-/, ''),
        ctxTokens,
        ctxWindow,
        isWindowGuessed: knownWindow === undefined,
        spentTokens: tally ? spentTokens : undefined,
        outputTokens: tally ? outputTokens : undefined,
        cacheRead: tally ? cacheRead : undefined,
        cacheWrite: tally ? cacheWrite : undefined,
        uncached: tally ? uncached : undefined,
        cacheTtlMs: tally?.ttlMs,
        lastResponseAt: tally?.lastAt,
      })
    }
  }

  for (const pid of cpuPrev.keys()) {
    if (!out.some(one => one.pid === pid)) cpuPrev.delete(pid)
  }

  return out.sort(
    (a, b) =>
      Number(b.isSelf) - Number(a.isSelf) ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.changedAt - a.changedAt,
  )
}

function summary(list: readonly RadarSession[]) {
  const count = (status: RadarStatus) => list.filter(one => one.status === status).length

  return { total: list.length, busy: count('busy'), waiting: count('waiting'), idle: count('idle') }
}

function statusLine(list: readonly RadarSession[]): string {
  const { total, busy, waiting } = summary(list)
  const parts = [`◉ ${total} Claude${total === 1 ? '' : 's'}`]
  if (busy) parts.push(`${busy} trabalhando`)
  if (waiting) parts.push(`${waiting} aguardando`)

  return parts.join(' · ')
}

async function announce($: EngineInterface, list: readonly RadarSession[]) {
  const previous = lastStatus
  lastStatus = new Map(list.map(one => [one.sessionId, one.status]))
  if (!previous || !(await read($, notify))) return

  for (const one of list) {
    const before = previous.get(one.sessionId)
    if (one.isSelf || before === undefined || before === one.status) continue
    if (one.status === 'waiting') $.ui.toast(`⚠ ${one.name} está aguardando você`, { timeoutMs: 6000 })
    else if (before === 'busy' && one.status === 'idle') $.ui.toast(`✓ ${one.name} terminou`)
  }
  for (const [id] of previous) {
    if (!lastStatus.has(id)) $.ui.toast('○ uma sessão do Claude foi encerrada')
  }
}

async function refresh($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  try {
    const own = await $.session.usage().catch(() => undefined)
    const list = await scan($, own)
    const windows: RadarLimit[] = (own?.rateLimits ?? []).map(one => ({
      kind: one.kind,
      percentUsed: one.percentUsed,
      resetsAt: one.resetsAt,
    }))
    await update($, limits, () => windows)
    await update($, sessions, () => list)
    const at = await $.clock.now()
    await update($, scannedAt, () => at)
    await update($, pulse, value => !value)
    $.ui.status(statusLine(list))
    await announce($, list)
  } finally {
    isScanning = false
  }
}

// Half hearts left: a whole heart is 20%, a half one 10%. A half goes out
// only once its 10% is spent, so a window starts with every heart full.
function halves(percentLeft: number): number {
  return Math.max(0, Math.min(HEARTS * 2, Math.ceil(percentLeft / 10)))
}

// "18:30", or with the date "09/10 18:30", in the host's local time.
function localTime(epochMs: number, withDate: boolean): string {
  const at = new Date(epochMs + utcOffsetMin * 60_000)
  const two = (n: number) => String(n).padStart(2, '0')
  const time = `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`

  return withDate ? `${two(at.getUTCDate())}/${two(at.getUTCMonth() + 1)} ${time}` : time
}

// A heart is two braille cells, its halves: the dots of
//   X..X
//   XXXX
//   XXXX
//   .XX.
// so it reads as one character tall and splits down the middle.
const HEART_HALVES = ['⢷', '⡾'] as const

// The row of hearts split where the lit halves end: [lit, unlit].
function heartRow(lit: number): [string, string] {
  let on = ''
  let off = ''
  for (let half = 0; half < HEARTS * 2; half++) {
    const glyph = (half > 0 && half % 2 === 0 ? ' ' : '') + HEART_HALVES[half % 2]
    if (half < lit) on += glyph
    else off += glyph
  }

  return [on, off]
}

async function sendTo($: EngineInterface, target: RadarSession, text: string) {
  const sent = await $.session.send({ to: { sessionId: target.sessionId }, text })
  if (sent.isDelivered) {
    draft = ''
    await update($, composeTo, () => '')
    $.ui.toast(`✉ mensagem entregue para ${target.name}`)
  } else {
    $.ui.toast(`✉ não entregue para ${target.name}: ${sent.reason}`, { timeoutMs: 8000 })
  }
}

const BAR = 12

// One row: a bar of the window used, its percentage, and what is left.
function ContextLine(props: {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  used: number
  window: number
  isGuessed: boolean
}) {
  const { Box, Text, used, window, isGuessed } = props
  const ratio = Math.min(1, used / window)
  const filled = Math.round(ratio * BAR)
  const color = ratio >= 0.85 ? 'red' : ratio >= 0.6 ? 'yellow' : 'green'
  const left = Math.max(0, window - used)

  return (
    <Box flexDirection="row">
      <Text dimColor>ctx </Text>
      <Text color={color}>{'▰'.repeat(filled)}</Text>
      <Text dimColor>{'▱'.repeat(BAR - filled)}</Text>
      <Text color={color}> {Math.round(ratio * 100)}%</Text>
      <Text dimColor>
        {' '}· faltam {tokens(left)} de {isGuessed ? '~' : ''}
        {tokens(window)}
      </Text>
    </Box>
  )
}

// Hit rate, what was read and written, and whether the prompt cache is still
// warm: it lives its TTL past the last response, so a reply after that pays to
// write the whole context again.
function CacheLine(props: {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  one: RadarSession
  now: number
}) {
  const { Box, Text, one, now } = props
  const read = one.cacheRead ?? 0
  const total = read + (one.cacheWrite ?? 0) + (one.uncached ?? 0)
  const hit = total > 0 ? Math.round((read / total) * 100) : 0
  const ttl = one.cacheTtlMs
  const left = ttl !== undefined && one.lastResponseAt !== undefined ? one.lastResponseAt + ttl - now : undefined
  const isWarm = left !== undefined && left > 0
  const color = !isWarm ? 'gray' : left < 5 * 60_000 ? 'yellow' : 'green'
  const ttlLabel = ttl === CACHE_TTL_1H ? '1h' : '5m'

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor wrap="truncate-end">
        cache {hit}% · {tokens(read)} lido · {tokens(one.cacheWrite ?? 0)} escrito
      </Text>
      {left !== undefined && (
        <Text color={color} dimColor={!isWarm}>
          {isWarm ? `◷ expira em ${ago(left)} (${ttlLabel})` : `◷ expirado (${ttlLabel})`}
        </Text>
      )}
    </Box>
  )
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, columns: 64 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.env.get('HOME')) ?? ''
    configOverride = await $.env.get('CLAUDE_CONFIG_DIR')
    selfId = await $.session.id()
    const zone = await $.process.run(['date', '+%z'], { timeoutMs: 2000 }).catch(() => undefined)
    const offset = /^([+-])(\d\d)(\d\d)/.exec(zone?.stdout.trim() ?? '')
    if (offset) utcOffsetMin = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]))
    const savedBg = await $.store.get('darkBg')
    if (typeof savedBg === 'boolean') await update($, darkBg, () => savedBg)
    await $.command.register({
      name: 'radar',
      description: 'Abre/fecha o painel com todas as sessões do Claude nesta máquina',
    })
    await refresh($)
    $.clock.every(SCAN_MS, () => void refresh($))

    return started
  })

  on('command.run', { command: 'radar' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })

      return { text: 'Radar fechado.' }
    }
    await refresh($)
    await openPane($)

    return { text: 'Radar aberto.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // mobile draws no Input: there the message button is left out.
    const Input = 'Input' in elements ? elements.Input : undefined
    const composing = await read($, composeTo)
    const isDark = await read($, darkBg)
    const windows = await read($, limits)
    const list = await read($, sessions)
    const at = await read($, scannedAt)
    const beat = await read($, pulse)
    const isNotifying = await read($, notify)
    const width = Math.max(24, e.props.bodyColumns ?? e.viewport?.columns ?? 60)
    // What is left inside the padding, which the width includes.
    const inner = width - PAD_X * 2
    const now = at || Date.now()
    const { total, busy, waiting, idle } = summary(list)
    const reachable = list.filter(one => !one.isSelf && one.canMessage)

    return (
      <Box
        flexDirection="column"
        width={width}
        paddingX={PAD_X}
        paddingY={PAD_Y}
        minHeight={e.props.scroll?.bodyRows}
        backgroundColor={isDark ? DARK_BG : undefined}
      >
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Box flexDirection="column">
            <Text bold color="cyan">
              ◎ RADAR
            </Text>
            <Text dimColor>{total === 1 ? '1 sessão' : `${total} sessões`}</Text>
          </Box>
          <Box flexDirection="column" alignItems="flex-end">
            {LIMIT_ROWS.map(row => {
              const reading = windows.find(one => one.kind === row.kind)
              const left = reading ? Math.max(0, 100 - reading.percentUsed) : 0
              const lit = reading ? halves(left) : 0
              const resetsAt = reading?.resetsAt ? Date.parse(reading.resetsAt) : NaN
              const reset = Number.isFinite(resetsAt)
                ? `[${ago(resetsAt - now)}] ${localTime(resetsAt, row.withDate)}`
                : ''

              return (
                <Box key={`limit-${row.kind}`} flexDirection="row" gap={1}>
                  <Text dimColor>{row.label}</Text>
                  <Box key={`hearts-${row.kind}`} flexDirection="row">
                    <Text color={row.color}>{heartRow(lit)[0]}</Text>
                    <Text color="gray">{heartRow(lit)[1]}</Text>
                  </Box>
                  <Text bold color={reading ? row.color : undefined} dimColor={!reading}>
                    {(reading ? `${Math.round(left)}%` : '—').padStart(4)}
                  </Text>
                  <Text dimColor>{reset.padEnd(RESET_WIDTH)}</Text>
                </Box>
              )
            })}
          </Box>
        </Box>
        <Box flexDirection="row" gap={2} marginBottom={1}>
          <Text color="green">● {busy} trabalhando</Text>
          <Text color="yellow">◆ {waiting} aguardando</Text>
          <Text dimColor>○ {idle} ociosa{idle === 1 ? '' : 's'}</Text>
        </Box>

        {list.length === 0 && <Text dimColor>Nenhuma sessão do Claude rodando agora.</Text>}

        {list.map(one => {
          const isComposing = composing === one.sessionId
          const slot = reachable.indexOf(one)
          const hotkey = slot >= 0 && slot < 9 ? String(slot + 1) : undefined
          const color = STATUS_COLOR[one.status]
          const glyph =
            one.status === 'busy' ? (beat ? '●' : '◉') : one.status === 'waiting' ? '◆' : '○'
          const metrics = [
            `${one.rssMb ?? '?'} MB`,
            one.cpu === undefined ? undefined : `${Math.round(one.cpu)}% cpu`,
            `aberta há ${ago(now - one.startedAt)}`,
          ]
            .filter(Boolean)
            .join(' · ')

          return (
            <Box
              key={`s-${one.sessionId}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={one.isSelf ? 'cyan' : color}
              borderDimColor={one.status === 'idle' && !one.isSelf}
              paddingX={1}
            >
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold color={one.status === 'idle' ? undefined : color} wrap="truncate-end">
                  {glyph} {one.name}
                  {one.isSelf ? '  (esta)' : ''}
                </Text>
                <Text color={color} dimColor={one.status === 'idle'}>
                  {STATUS_LABEL[one.status]} · {ago(now - one.changedAt)}
                </Text>
              </Box>
              {one.waitingFor && one.status === 'waiting' && (
                <Text color="yellow">↳ {one.waitingFor}</Text>
              )}
              <Text color="blue">{fit(tildify(one.cwd), inner - 4)}</Text>
              {one.lastPrompt ? (
                <Box flexDirection="row">
                  <Text color="magenta">❯ </Text>
                  <Text italic>
                    {cut(one.lastPrompt, inner - 4 - 2 - (one.lastPromptAt ? ago(now - one.lastPromptAt).length + 3 : 0))}
                  </Text>
                  {one.lastPromptAt ? <Text dimColor> · {ago(now - one.lastPromptAt)}</Text> : null}
                </Box>
              ) : (
                <Text dimColor>❯ nenhum prompt ainda</Text>
              )}
              {one.ctxTokens !== undefined && one.ctxWindow ? (
                <ContextLine
                  Box={Box}
                  Text={Text}
                  used={one.ctxTokens}
                  window={one.ctxWindow}
                  isGuessed={one.isWindowGuessed ?? false}
                />
              ) : null}
              {one.spentTokens !== undefined && (
                <Text dimColor wrap="truncate-end">
                  Σ {tokens(one.spentTokens)} tokens gastos · {tokens(one.outputTokens ?? 0)} de saída
                  {one.model ? ` · ${one.model}` : ''}
                </Text>
              )}
              {one.cacheRead !== undefined && <CacheLine Box={Box} Text={Text} one={one} now={now} />}
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor wrap="truncate-end">
                  {metrics}
                </Text>
                <Text dimColor>
                  {one.profile} · {one.entrypoint} · v{one.version} · pid {one.pid}
                </Text>
              </Box>
              {!one.isSelf && (
                <Box flexDirection="row" gap={1}>
                  <Button
                    key={`resume-${one.sessionId}`}
                    plain
                    dimColor
                    onPress={async () => {
                      const copied = await $.ui.copy({
                        text: `cd ${one.cwd} && claude --resume ${one.sessionId}`,
                        surface: e.surface,
                      })
                      $.ui.toast(copied.isCopied ? '⧉ comando de resume copiado' : 'não deu pra copiar')
                    }}
                  >
                    ⧉ copiar resume
                  </Button>
                  <Button
                    key={`cwd-${one.sessionId}`}
                    plain
                    dimColor
                    onPress={async () => {
                      const copied = await $.ui.copy({ text: one.cwd, surface: e.surface })
                      $.ui.toast(copied.isCopied ? '⧉ caminho copiado' : 'não deu pra copiar')
                    }}
                  >
                    ⧉ copiar caminho
                  </Button>
                  {Input && one.canMessage && (
                    <Button
                      key={`msg-${one.sessionId}`}
                      plain
                      hotkey={hotkey}
                      dimColor={!isComposing}
                      onPress={async () => {
                        draft = ''
                        await update($, composeTo, open => (open === one.sessionId ? '' : one.sessionId))
                        await $.ui.focus({ requestId: PANE, key: 'msg-input' }).catch(() => undefined)
                      }}
                    >
                      {isComposing ? '✕ cancelar' : '✉ mensagem'}
                    </Button>
                  )}
                </Box>
              )}
              {Input && isComposing && (
                <Input
                  key="msg-input"
                  label={`✉ ${one.name}: `}
                  placeholder="escreva e tecle Enter (vazio cancela)"
                  submitLabel="enviar"
                  value={draft}
                  autoFocus
                  onInput={value => {
                    draft = value
                  }}
                  onSubmit={async value => {
                    const text = value.trim()
                    if (!text) {
                      draft = ''
                      await update($, composeTo, () => '')
                      return
                    }
                    await sendTo($, one, text)
                  }}
                />
              )}
            </Box>
          )
        })}

        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Text dimColor>atualiza a cada {SCAN_MS / 1000}s</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="toggle-notify"
              hotkey="n"
              plain
              onPress={() => update($, notify, value => !value)}
            >
              {isNotifying ? 'avisos: on' : 'avisos: off'}
            </Button>
            <Button
              key="toggle-bg"
              hotkey="b"
              plain
              onPress={async () => {
                const next = !isDark
                await update($, darkBg, () => next)
                await $.store.set('darkBg', next)
              }}
            >
              {isDark ? 'fundo: escuro' : 'fundo: padrão'}
            </Button>
            <Button key="refresh" hotkey="r" plain onPress={() => refresh($)}>
              atualizar
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
