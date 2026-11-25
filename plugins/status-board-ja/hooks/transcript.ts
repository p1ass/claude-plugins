import type { PlanStep, SessionRecord, StepStatus, TimelineEvent } from '../types'

const TOOL_PLAN = 'mcp__ccd_turn__update_plan'
const TOOL_WRAP = 'mcp__ccd_turn__wrap_up'
const TOOL_DIALOG = 'AskUserQuestion'
const STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'completed']
const TEXT_LIMIT = 200
const RECAP_LIMIT = 1_000
const KEEP = 300

type Json = Record<string, unknown>

export function createRecord(): SessionRecord {
  return { events: [], plan: [], currentSince: null, prLinks: {} }
}

export function applyLine(record: SessionRecord, line: string): boolean {
  const row = parseRow(line)
  if (row === null || row.isSidechain === true) return false
  const ts = Date.parse(String(row.timestamp ?? ''))
  if (Number.isNaN(ts)) return false

  if (row.type === 'pr-link') return applyPullRequest(record, row, ts)
  if (row.type === 'user') return applyPrompt(record, row, ts)
  if (row.type === 'assistant') {
    const content = asJson(row.message)?.content
    if (!Array.isArray(content)) return false
    let isChanged = false
    for (const block of content) {
      const use = asJson(block)
      if (use?.type === 'tool_use') isChanged = applyToolUse(record, String(use.name ?? ''), asJson(use.input) ?? {}, ts) || isChanged
    }
    return isChanged
  }
  return false
}

export function applyPlanUpdate(plan: readonly PlanStep[], input: Json): PlanStep[] {
  if (Array.isArray(input.items)) {
    return input.items.map(item => {
      const step = asJson(item) ?? {}
      return { content: String(step.content ?? ''), status: toStatus(step.status) }
    })
  }
  const next = plan.map(step => ({ ...step }))
  if (input.advance === true) {
    const current = next.find(step => step.status === 'in_progress')
    if (current) current.status = 'completed'
    const upcoming = next.find(step => step.status === 'pending')
    if (upcoming) upcoming.status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const position of input.done) {
      const step = typeof position === 'number' ? next[position - 1] : undefined
      if (step) step.status = 'completed'
    }
  }
  if (typeof input.start === 'number') {
    const step = next[input.start - 1]
    if (step) step.status = 'in_progress'
  }
  return next
}

export function findPromptText(content: unknown): string {
  const parts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap(block => {
            const text = asJson(block)
            return text?.type === 'text' && typeof text.text === 'string' ? [text.text] : []
          })
        : []
  return parts
    .join('\n')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()
}

function applyPrompt(record: SessionRecord, row: Json, ts: number): boolean {
  const isPersonTyped = asJson(row.origin)?.kind === 'human' && row.promptSource !== 'system' && row.isMeta !== true
  if (!isPersonTyped) return false
  const text = findPromptText(asJson(row.message)?.content)
  if (text === '') return false
  push(record, { kind: 'prompt', ts, text: clip(text, TEXT_LIMIT) })
  return true
}

function applyPullRequest(record: SessionRecord, row: Json, ts: number): boolean {
  const url = String(row.prUrl ?? '')
  const number = Number(row.prNumber)
  if (!/^https:\/\/[^\s()<>]+$/.test(url) || !Number.isSafeInteger(number) || number <= 0) return false
  if (record.events.some(event => event.kind === 'pr' && event.url === url)) return false
  const key = String(number)
  const known = record.prLinks[key]
  record.prLinks[key] = known === undefined || known === url ? url : null
  push(record, { kind: 'pr', ts, number, url })
  return true
}

function applyToolUse(record: SessionRecord, tool: string, input: Json, ts: number): boolean {
  if (tool === TOOL_DIALOG) {
    const questions = Array.isArray(input.questions)
      ? input.questions.map(q => clip(String(asJson(q)?.question ?? ''), RECAP_LIMIT)).filter(text => text !== '')
      : []
    push(record, { kind: 'dialog', ts, text: questions[0] ?? '（質問の文面なし）', more: Math.max(0, questions.length - 1) })
    return true
  }
  if (tool === TOOL_PLAN) {
    const next = applyPlanUpdate(record.plan, input)
    const events = diffPlan(record.plan, next, ts)
    for (const event of events) push(record, event)
    const current = next.findIndex(step => step.status === 'in_progress')
    const before = record.plan.findIndex(step => step.status === 'in_progress')
    if (current === -1) record.currentSince = null
    else if (current !== before || record.plan[before]?.content !== next[current]?.content) record.currentSince = ts
    record.plan = next
    return events.length > 0
  }
  if (tool === TOOL_WRAP) {
    const ask = typeof input.ask === 'string' && input.ask.trim() !== '' ? clip(input.ask, RECAP_LIMIT) : null
    push(record, { kind: 'recap', ts, text: clip(String(input.recap ?? ''), RECAP_LIMIT), ask })
    if (input.blocked !== true) {
      record.plan = record.plan.map(step => ({ ...step, status: 'completed' }))
      record.currentSince = null
    }
    return true
  }
  return false
}

function diffPlan(prev: readonly PlanStep[], next: readonly PlanStep[], ts: number): TimelineEvent[] {
  const isSameSteps = prev.length === next.length && prev.every((step, i) => step.content === next[i]?.content)
  if (!isSameSteps) {
    const isFresh = prev.length === 0 || prev.every(step => step.status === 'completed')
    return [{ kind: 'plan', ts, isFresh, steps: next.length }]
  }
  return next.flatMap((step, i) =>
    step.status === prev[i]?.status ? [] : [{ kind: 'step', ts, to: step.status, text: clip(step.content, TEXT_LIMIT) } as const],
  )
}

function push(record: SessionRecord, event: TimelineEvent): void {
  record.events.push(event)
  if (record.events.length > KEEP) record.events.splice(0, record.events.length - KEEP)
}

function parseRow(line: string): Json | null {
  try {
    return asJson(JSON.parse(line))
  } catch {
    return null
  }
}

function asJson(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
}

function toStatus(value: unknown): StepStatus {
  return STATUSES.find(status => status === value) ?? 'pending'
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}
