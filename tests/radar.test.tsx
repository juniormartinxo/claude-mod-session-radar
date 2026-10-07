import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/dev'
const SESSIONS = `${HOME}/.claude/sessions`

// /proc/<pid>/stat with procStart at field 22 (index 19 after the comm).
function stat(procStart: string, ticks = 100) {
  const fields = Array.from({ length: 40 }, () => '0')
  fields[11] = String(ticks)
  fields[19] = procStart
  return `123 (claude) ${fields.join(' ')}`
}

const HISTORY = [
  { display: 'prompt antigo da api', timestamp: 1_000, sessionId: 'other-id' },
  { display: 'conserta o\n  endpoint de login', timestamp: 30_000, sessionId: 'other-id' },
  { display: 'cria o painel', timestamp: 50_000, sessionId: 'self-id' },
]
  .map(row => JSON.stringify(row))
  .join('\n') + '\n{"display":"linha cortada'

let toasts: string[] = []
let sent: { to: unknown; text: string }[] = []

const usageRow = (id: string, usage: object, isSidechain = false, at = 0) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain,
    timestamp: new Date(at).toISOString(),
    message: { id, model: 'claude-opus-5-5', usage },
  })

const TRANSCRIPTS: Record<string, string> = {
  // One response streamed as two rows (same id), a subagent's, then the latest.
  [`${HOME}/.claude/projects/-home-dev-api/other-id.jsonl`]:
    [
      usageRow('m1', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 5 }),
      usageRow('m1', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 50 }),
      usageRow('s1', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 100 }, true),
      JSON.stringify({ type: 'user', message: { content: 'oi' } }),
      usageRow(
        'm2',
        {
          input_tokens: 5,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 20000,
          output_tokens: 300,
          cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
        },
        false,
        30_000,
      ),
    ].join('\n') + '\n',
  [`${HOME}/.claude/projects/-home-dev-app/self-id.jsonl`]:
    usageRow(
      'x1',
      {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 999,
        output_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5 },
      },
      false,
      -300_000,
    ) + '\n',
}

function fakeMachine(on: On) {
  toasts = []
  sent = []
  mock.env(on, { HOME })
  on('session.id', () => ({ value: 'self-id' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.focus', () => ({ value: { isFocused: true } }) as never)
  on('session.send', ($, e) => {
    sent.push(e)
    return { isDelivered: true as const }
  })
  on('fs.list', ($, e) => {
    if (e.path === SESSIONS) {
      return { value: ['10.json', '20.json', '30.json'].map(name => ({
        name,
        kind: 'file' as const,
        size: 1,
        mtimeMs: 1,
        isLink: false,
      })) }
    }
    throw new Error('ENOENT')
  })
  on('fs.stat', ($, e) => {
    const text = e.path === `${HOME}/.claude/history.jsonl` ? HISTORY : TRANSCRIPTS[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'date') {
      return { value: { exitCode: 0, stdout: '-0300\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const [, , from, path] = e.argv
    const text = TRANSCRIPTS[path ?? ''] ?? ''
    const stdout = text.slice(Number(from?.slice(1) ?? 1) - 1)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 41.5, resetsAt: new Date(60_000 + 2 * 3600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 75, resetsAt: new Date(60_000 + (4 * 24 + 15) * 3600_000).toISOString() },
      ],
    },
  }))
  on('fs.read', ($, e) => {
    const files: Record<string, string> = {
      [`${SESSIONS}/10.json`]: JSON.stringify({
        pid: 10, sessionId: 'self-id', cwd: `${HOME}/app`, name: 'eu-mesmo',
        status: 'busy', procStart: '111', startedAt: 0, version: '2.1.289', entrypoint: 'cli',
      }),
      [`${SESSIONS}/20.json`]: JSON.stringify({
        pid: 20, sessionId: 'other-id', cwd: `${HOME}/api`, name: 'api-server',
        messagingSocketPath: '/run/user/1000/cc-socks/20.sock',
        status: 'waiting', waitingFor: 'permission', procStart: '222', startedAt: 0, version: '2.1.289', entrypoint: 'cli',
      }),
      // pid alive but reused by another process: a stale file, must be hidden
      [`${SESSIONS}/30.json`]: JSON.stringify({
        pid: 30, sessionId: 'dead-id', cwd: `${HOME}/old`, name: 'fantasma',
        status: 'idle', procStart: '999', startedAt: 0,
      }),
      [`${HOME}/.claude/history.jsonl`]: HISTORY,
      '/proc/10/stat': stat('111'),
      '/proc/20/stat': stat('222'),
      '/proc/30/stat': stat('333'),
      '/proc/10/status': 'VmRSS:\t  204800 kB\n',
      '/proc/20/status': 'VmRSS:\t  102400 kB\n',
    }
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`lista só as sessões vivas (${surface})`, async ($, on) => {
    mock.clock(on, { now: 60_000 })
    mock.store(on)
    fakeMachine(on)
    await $.session.start({ cwd: `${HOME}/app`, surface, isInteractive: true })

    const ui = await $.ui.mount({
      plugin: 'session-radar',
      surface,
      component: 'Pane',
      requestId: 'session-radar',
      props: { title: 'Radar', isFocused: false, bodyColumns: 70, placement: 'dock' } as never,
    })

    expect(await ui.find({ text: /eu-mesmo/ })).toBeDefined()
    expect(await ui.find({ text: /\(esta\)/ })).toBeDefined()
    expect(await ui.find({ text: /api-server/ })).toBeDefined()
    expect(await ui.find({ text: /aguardando você/ })).toBeDefined()
    expect(await ui.find({ text: /permission/ })).toBeDefined()
    expect(await ui.find({ text: /~\/api/ })).toBeDefined()
    expect(await ui.find({ text: /200 MB/ })).toBeDefined()
    expect(await ui.find({ text: /fantasma/ })).toBeUndefined()

    // The newest prompt of each session, whitespace folded, with its age.
    expect(await ui.find({ text: 'conserta o endpoint de login' })).toBeDefined()
    expect(await ui.find({ text: /prompt antigo/ })).toBeUndefined()
    expect(await ui.find({ text: 'cria o painel' })).toBeDefined()
    expect(await ui.find({ text: /· 30s/ })).toBeDefined()
    expect(await ui.find({ text: /2 sessões/ })).toBeDefined()

    // Only other sessions offer the copy buttons.
    expect(await ui.find({ key: 'resume-other-id' })).toBeDefined()
    expect(await ui.find({ key: 'resume-self-id' })).toBeUndefined()

    // Usage windows, a heart 20% and a half 10%: 58.5% left lights six
    // halves (three hearts), 25% three halves (a heart and a half).
    // Then the time to the reset in brackets and its local time (UTC-3 here):
    // the hour alone for 5h, the date too for 7d.
    expect((await ui.find({ key: 'limit-five_hour' }))?.text).toMatch(/5h.* 59%\[2h00\] 23:01 +$/)
    expect((await ui.find({ key: 'limit-seven_day' }))?.text).toMatch(/7d.* 25%\[4d 15h\] 05\/01 12:01$/)
    const lit = async (text: string) => (await ui.findAll({ type: 'Text', text: new RegExp(`^${text}$`) })).map(one => one.props.color)
    expect((await ui.find({ key: 'hearts-five_hour' }))?.text).toBe('⢷⡾ ⢷⡾ ⢷⡾ ⢷⡾ ⢷⡾')
    expect(await lit('⢷⡾ ⢷⡾ ⢷⡾')).toEqual(['yellow'])
    expect(await lit(' ⢷⡾ ⢷⡾')).toEqual(['gray'])
    expect(await lit('⢷⡾ ⢷')).toEqual(['red'])
    expect(await lit('⡾ ⢷⡾ ⢷⡾ ⢷⡾')).toEqual(['gray'])

    // Tokens: this session's context from the engine, the other's from its
    // transcript (latest main-thread response), each response counted once.
    expect(await ui.find({ text: /faltam 150k de 200k/ })).toBeDefined()
    expect(await ui.find({ text: /faltam 179k de 200k/ })).toBeDefined()
    expect(await ui.find({ text: /de ~/ })).toBeUndefined()
    expect(await ui.find({ text: /Σ 36k tokens gastos · 450 de saída · opus-5-5/ })).toBeDefined()
    expect(await ui.find({ text: / 25%/ })).toBeDefined()
    expect(await ui.find({ text: / 10%/ })).toBeDefined()

    // Cache: 34k read of 35 515 input is 96%; the 1h cache written at 30s is
    // warm until 1h30s (now is 60s), the 5m one written at -5 min is gone.
    expect(await ui.find({ text: 'cache 96% · 34k lido · 1,5k escrito' })).toBeDefined()
    expect(await ui.find({ text: '◷ expira em 59 min (1h)' })).toBeDefined()
    expect(await ui.find({ text: 'cache 100% · 999 lido · 0 escrito' })).toBeDefined()
    expect(await ui.find({ text: '◷ expirado (5m)' })).toBeDefined()

    // Messaging: only other sessions with a socket get the button.
    expect(await ui.find({ key: 'msg-self-id' })).toBeUndefined()
    expect(await ui.find({ key: 'msg-input' })).toBeUndefined()
    await ui.press({ key: 'msg-other-id' })
    expect(await ui.find({ key: 'msg-input' })).toBeDefined()
    expect((await ui.find({ key: 'msg-other-id' }))?.text).toMatch(/cancelar/)

    await ui.input({ key: 'msg-input', text: '  roda os testes de novo  ' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'other-id', text: 'roda os testes de novo' })
    expect(toasts).toContain('✉ mensagem entregue para api-server')
    expect(await ui.find({ key: 'msg-input' })).toBeUndefined()

    // An empty Enter cancels without sending.
    await ui.press({ key: 'msg-other-id' })
    await ui.input({ key: 'msg-input', text: '   ' })
    expect(sent).toHaveLength(1)
    expect(await ui.find({ key: 'msg-input' })).toBeUndefined()

    // The pane paints its own dark background, and b switches it off.
    expect(await ui.drawn()).toMatchObject({ props: { backgroundColor: 'black' } })
    await ui.press({ key: 'toggle-bg' })
    expect(await ui.drawn()).not.toMatchObject({ props: { backgroundColor: 'black' } })
    expect((await ui.find({ key: 'toggle-bg' }))?.text).toMatch(/fundo: padrão/)

    await ui.press({ key: 'toggle-notify' })
    expect((await ui.find({ key: 'toggle-notify' }))?.text).toMatch(/avisos: off/)
  })
}
