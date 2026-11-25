import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, ModelUsage, Register } from 'claude-code'

import type { Activity, Board, PaneView, SessionRecord } from '../types'
import { HEADINGS, SUMMARY_PROMPT, cleanReply, hasAllHeadings, linkPullRequests } from './board'
import { buildCards, buildFooter } from './history'
import type { Card } from './history'
import { applyLine, createRecord } from './transcript'
import { TEXTS, createClock, findCurrentStep, formatTokens, oneLine } from './texts'
import type { Clock } from './texts'

type Engine = EngineInterface

const PANE = 'status-board'
const COMMAND = 'board'
const CHUNK = 4 * 1024 * 1024
const LINE_LIMIT = 64 * 1024 * 1024
const START_DELAY_MS = 250
const TICK_MS = 2_000
const IDLE_READ_MS = 30_000
const WARM_MS = 5 * 60 * 1000
const BOARD_TTL_MS = 8 * 24 * 60 * 60 * 1000
const FAILURES_SHOWN = 3
const CARDS_SHOWN = 5
const NEWLINE = 0x0a

const record = atom({ plugin: 'status-board', key: 'record' } as const, createRecord(), { shape: 'record-1' })
const board = atom({ plugin: 'status-board', key: 'board' } as const, null, { shape: 'board-2' })
const activity = atom({ plugin: 'status-board', key: 'activity' } as const, {
  isTurnRunning: false,
  lastTurnEndedAt: null,
  lastActivityAt: 0,
} satisfies Activity)
const isSummarizing = atom({ plugin: 'status-board', key: 'isSummarizing' } as const, false)
const view = atom({ plugin: 'status-board', key: 'view' } as const, {
  isHistoryShown: false,
  isAllShown: false,
} satisfies PaneView)
const failure = atom({ plugin: 'status-board', key: 'failure' } as const, null as string | null)

type Reader = { path: string; offset: number; carry: Uint8Array; isSkipping: boolean; failures: number; lastReadAt: number }

type Context = {
  reader: Reader
  data: SessionRecord
  sessionId: string
  clock: Clock
  isReading: boolean
  isSummaryRunning: boolean
  isRerunWanted: boolean
}

const ctx: Context = {
  reader: newReader(''),
  data: createRecord(),
  sessionId: '',
  clock: createClock(undefined),
  isReading: false,
  isSummaryRunning: false,
  isRerunWanted: false,
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    ctx.clock = createClock(await $.env.get('TZ'))
    await $.command.register({ name: COMMAND, description: TEXTS.commandDescription })
    await update($, isSummarizing, () => false)
    await pruneBoards($)
    await readTranscript($)
    $.clock.every(TICK_MS, () => {
      void tick($)
    })
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isOpened = await togglePane($)
    return { text: isOpened ? TEXTS.commandOpened : TEXTS.commandClosed }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, activity, a => ({ ...a, isTurnRunning: true, lastActivityAt: Math.max(a.lastActivityAt, now) }))
      $.clock.after(START_DELAY_MS, () => {
        void readTranscript($)
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const now = await $.clock.now()
    await update($, activity, a => ({ isTurnRunning: false, lastTurnEndedAt: now, lastActivityAt: Math.max(a.lastActivityAt, now) }))
    void readTranscript($)
    if (e.reason === 'answer' && (await isPaneShown($))) {
      if (ctx.isSummaryRunning) ctx.isRerunWanted = true
      else void summarize($)
    }
    return result
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const [current, shownBoard, act, isBusy, paneView, problem] = await Promise.all([
      read($, record),
      read($, board),
      read($, activity),
      read($, isSummarizing),
      read($, view),
      read($, failure),
    ])
    const now = await $.clock.now()
    const cards = buildCards(current.events)

    if (e.props.placement === 'widget') {
      const glance = findGlance(cards)
      return <Text maxLines={3}>{glance ?? TEXTS.paneTitle}</Text>
    }

    const isStale = shownBoard !== null && act.lastActivityAt > shownBoard.at
    const isWarm = act.isTurnRunning || (act.lastTurnEndedAt !== null && now - act.lastTurnEndedAt < WARM_MS)
    const updateLabel = isBusy
      ? TEXTS.summarizing
      : (shownBoard === null ? TEXTS.create : TEXTS.update) + (isWarm ? '' : TEXTS.coldSuffix)
    const shownCards = paneView.isAllShown ? [...cards].reverse() : [...cards].reverse().slice(0, CARDS_SHOWN)
    const step = findCurrentStep(current)
    const isBordered = e.surface !== 'terminal'

    return (
      <Box flexDirection="column" gap={1}>
        {shownBoard === null ? (
          <Text dimColor>{TEXTS.emptyBoard}</Text>
        ) : (
          <Markdown key="board" text={linkPullRequests(shownBoard.summary, current.prLinks)} />
        )}
        {shownBoard !== null && <Text dimColor>{describeBoard(shownBoard, isStale, now)}</Text>}
        <Button
          key="update"
          variant="primary"
          label={updateLabel}
          onPress={() => {
            if (!ctx.isSummaryRunning) void summarize($)
          }}
        />
        {problem !== null && <Text color="error">{TEXTS.summaryFailed(problem)}</Text>}
        <Button
          key="history"
          label={paneView.isHistoryShown ? TEXTS.hideHistory : TEXTS.showHistory}
          onPress={() => update($, view, v => ({ ...v, isHistoryShown: !v.isHistoryShown }))}
        />
        {paneView.isHistoryShown && cards.length === 0 && <Text dimColor>{TEXTS.noHistory}</Text>}
        {paneView.isHistoryShown &&
          shownCards.map((card, i) => (
            <Box
              key={`card-${card.ts ?? 'start'}-${i}`}
              flexDirection="column"
              borderStyle={isBordered ? 'round' : undefined}
              borderDimColor={isBordered ? true : undefined}
              paddingX={isBordered ? 1 : 0}
            >
              <Text maxLines={3}>
                <Text color="remember">○ </Text>
                {card.ts === null || card.prompt === null ? (
                  <Text dimColor>{TEXTS.beforeFirstPrompt}</Text>
                ) : (
                  <Text>
                    <Text dimColor>{ctx.clock.format(card.ts, now)} </Text>
                    {oneLine(card.prompt)}
                  </Text>
                )}
              </Text>
              {card.notes.map(note => (
                <Box flexDirection="column">
                  <Text>
                    <Text color="warning">{note.kind === 'recap' ? '○ ' : '● '}</Text>
                    <Text dimColor>{ctx.clock.format(note.ts, now)} </Text>
                    {note.kind === 'dialog' && <Text bold>{TEXTS.askLabel} </Text>}
                    {note.kind === 'recap' ? note.text : note.text + (note.more > 0 ? `（ほか ${note.more} 件）` : '')}
                  </Text>
                  {note.kind === 'recap' && note.ask !== null && <Text color="warning">質問: {note.ask}</Text>}
                </Box>
              ))}
              {i === 0 && step !== null && (
                <Text>
                  <Text color="permission">● </Text>
                  <Text bold>{step.label} </Text>
                  {step.text}
                </Text>
              )}
              {buildFooter(card) !== null && <Text dimColor>{buildFooter(card)}</Text>}
            </Box>
          ))}
        {paneView.isHistoryShown && cards.length > CARDS_SHOWN && (
          <Button
            key="more"
            label={paneView.isAllShown ? TEXTS.showLatest(CARDS_SHOWN) : TEXTS.showAll(cards.length - CARDS_SHOWN)}
            onPress={() => update($, view, v => ({ ...v, isAllShown: !v.isAllShown }))}
          />
        )}
      </Box>
    )
  })
}

async function tick($: Engine): Promise<void> {
  const act = await read($, activity)
  const now = await $.clock.now()
  if (act.isTurnRunning || now - ctx.reader.lastReadAt >= IDLE_READ_MS) await readTranscript($)
}

async function togglePane($: Engine): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const opened = await $.ui.open({ id: PANE, title: TEXTS.paneTitle })
  if (opened.isPlaced) await summarizeIfStale($)
  return true
}

async function summarizeIfStale($: Engine): Promise<void> {
  if (ctx.isSummaryRunning) return
  const [shownBoard, act] = await Promise.all([read($, board), read($, activity)])
  const now = await $.clock.now()
  const isWarm = act.isTurnRunning || (act.lastTurnEndedAt !== null && now - act.lastTurnEndedAt < WARM_MS)
  const isStale = shownBoard === null || act.lastActivityAt > shownBoard.at
  if (isStale && isWarm) void summarize($)
}

async function isPaneShown($: Engine): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
}

async function summarize($: Engine): Promise<void> {
  ctx.isSummaryRunning = true
  ctx.isRerunWanted = false
  try {
    await update($, isSummarizing, () => true)
    await update($, failure, () => null)
    const at = await $.clock.now()
    const reply = await $.model.fork({ prompt: SUMMARY_PROMPT })
    if (!reply.isAnswered) {
      await update($, failure, () => describeFailure(reply))
      return
    }
    const summary = cleanReply(reply.text)
    if (!hasAllHeadings(summary)) {
      await update($, failure, () => `応答に ${HEADINGS.length} つの見出しがそろっていません`)
      return
    }
    const summarized: Board = { summary, at, inputTokens: sumInput(reply.usage), outputTokens: reply.usage.output_tokens }
    await update($, board, () => summarized)
    await saveBoard($, summarized)
  } finally {
    await update($, isSummarizing, () => false)
    ctx.isSummaryRunning = false
    if (ctx.isRerunWanted) void summarize($)
  }
}




async function readTranscript($: Engine): Promise<void> {
  if (ctx.isReading) return
  ctx.isReading = true
  try {
    const { transcriptPath } = await $.session.info()
    if (transcriptPath !== ctx.reader.path) await switchSession($, transcriptPath)
    ctx.reader.lastReadAt = await $.clock.now()
    if (transcriptPath === '' || !(await $.fs.exists(transcriptPath))) return
    const { size } = await $.fs.stat(transcriptPath)
    if (size < ctx.reader.offset) await switchSession($, transcriptPath)
    let isChanged = false
    while (ctx.reader.offset < size) {
      const length = Math.min(CHUNK, size - ctx.reader.offset)
      const { base64 } = await $.fs.read(transcriptPath, { as: 'bytes', offset: ctx.reader.offset, length })
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
      if (bytes.length === 0) break
      ctx.reader.offset += bytes.length
      isChanged = consume(bytes) || isChanged
    }
    ctx.reader.failures = 0
    $.ui.status(undefined)
    if (isChanged) {
      const snapshot = structuredClone(ctx.data)
      const lastTs = snapshot.events.at(-1)?.ts ?? 0
      await update($, record, () => snapshot)
      await update($, activity, a => ({ ...a, lastActivityAt: Math.max(a.lastActivityAt, lastTs) }))
    }
  } catch (error) {
    ctx.reader.failures += 1
    if (ctx.reader.failures >= FAILURES_SHOWN) $.ui.status(TEXTS.readFailed(error instanceof Error ? error.message : String(error)))
  } finally {
    ctx.isReading = false
  }
}

function consume(bytes: Uint8Array): boolean {
  const joined = new Uint8Array(ctx.reader.carry.length + bytes.length)
  joined.set(ctx.reader.carry)
  joined.set(bytes, ctx.reader.carry.length)
  const decoder = new TextDecoder('utf-8')
  let start = 0
  let isChanged = false
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] !== NEWLINE) continue
    if (ctx.reader.isSkipping) ctx.reader.isSkipping = false
    else if (i > start) isChanged = applyLine(ctx.data, decoder.decode(joined.subarray(start, i))) || isChanged
    start = i + 1
  }
  const rest = joined.subarray(start)
  if (rest.length > LINE_LIMIT) {
    ctx.reader.isSkipping = true
    ctx.reader.carry = new Uint8Array(0)
  } else {
    ctx.reader.carry = ctx.reader.isSkipping ? new Uint8Array(0) : rest.slice()
  }
  return isChanged
}

async function switchSession($: Engine, path: string): Promise<void> {
  ctx.reader = newReader(path)
  ctx.data = createRecord()
  ctx.sessionId = await $.session.id()
  const saved = await loadBoard($, ctx.sessionId)
  await update($, record, () => createRecord())
  await update($, board, () => saved)
  await update($, failure, () => null)
  await update($, activity, a => ({ ...a, lastActivityAt: 0 }))
}

async function saveBoard($: Engine, saved: Board): Promise<void> {
  if (ctx.sessionId === '') return
  await $.store.set(`board:${ctx.sessionId}`, { board: saved, savedAt: await $.clock.now() })
}

function newReader(path: string): Reader {
  return { path, offset: 0, carry: new Uint8Array(0), isSkipping: false, failures: 0, lastReadAt: 0 }
}

function describeBoard(shownBoard: Board, isStale: boolean, now: number): string {
  const parts = [
    `${ctx.clock.format(shownBoard.at, now)} 時点の要約`,
    isStale ? '要約の後に会話が進行' : null,
    shownBoard.inputTokens + shownBoard.outputTokens > 0
      ? `入力 ${formatTokens(shownBoard.inputTokens)} / 出力 ${formatTokens(shownBoard.outputTokens)}`
      : null,
  ]
  return parts.filter(part => part !== null).join('・')
}

function findGlance(cards: readonly Card[]): string | null {
  const latest = cards.at(-1)
  if (latest === undefined) return null
  const recap = latest.notes.findLast(note => note.kind === 'recap')
  return oneLine(recap?.text ?? latest.prompt ?? '')
}

function sumInput(usage: ModelUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

function describeFailure(reply: Extract<ModelForkResult, { isAnswered: false }>): string {
  switch (reply.reason) {
    case 'nothing-to-fork':
      return '要約する会話がまだありません'
    case 'api-error':
      return `API のエラー（${[reply.status, reply.error].filter(Boolean).join('、')}）`
    case 'empty-reply':
      return 'モデルの応答が空でした'
    case 'aborted':
      return '要求が中断されました'
  }
}

async function loadBoard($: Engine, id: string): Promise<Board | null> {
  const saved = (await $.store.get(`board:${id}`)) as { board?: Board } | undefined
  const found = saved?.board
  return found && typeof found.summary === 'string' && typeof found.at === 'number'
    ? { summary: found.summary, at: found.at, inputTokens: found.inputTokens ?? 0, outputTokens: found.outputTokens ?? 0 }
    : null
}

async function pruneBoards($: Engine): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('board:')) continue
    const saved = (await $.store.get(key)) as { savedAt?: number } | undefined
    if (typeof saved?.savedAt !== 'number' || now - saved.savedAt > BOARD_TTL_MS) await $.store.delete(key)
  }
}

