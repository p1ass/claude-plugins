import type { SessionRecord } from '../types'

export const TEXTS = {
  paneTitle: 'ステータスボード',
  commandDescription: 'ステータスボードのペインを開閉する',
  commandOpened: 'ステータスボードを開きました。',
  commandClosed: 'ステータスボードを閉じました。',
  emptyBoard: 'ステータスボードはまだありません。下のボタンで作成できます。',
  create: 'ステータスボードを作成',
  update: 'ステータスボードを更新',
  coldSuffix: '（キャッシュが失効している可能性あり）',
  summarizing: '要約中…',
  showHistory: '履歴を表示',
  hideHistory: '履歴を隠す',
  showAll: (rest: number) => `残りの ${rest} 件を表示`,
  showLatest: (count: number) => `最新の ${count} 件だけ表示`,
  beforeFirstPrompt: '最初の指示より前',
  noHistory: '表示する履歴はまだありません。',
  summaryFailed: (reason: string) => `要約できませんでした: ${reason}`,
  readFailed: (reason: string) => `ステータスボード: トランスクリプトを読み取れません: ${reason}`,
  askLabel: '質問',
} as const

export type CurrentStep = { label: string; text: string; since: number | null }

export function findCurrentStep(record: SessionRecord): CurrentStep | null {
  const index = record.plan.findIndex(step => step.status === 'in_progress')
  const step = record.plan[index]
  if (step === undefined) return null
  return { label: `実行中（${index + 1}/${record.plan.length}）`, text: oneLine(step.content), since: record.currentSince }
}

export type Clock = { format: (ts: number, now: number) => string }

export function createClock(timeZone: string | undefined): Clock {
  const formatter = buildFormatter(timeZone)
  const parts = (ts: number) => {
    const found: Record<string, string> = {}
    for (const part of formatter.formatToParts(ts)) found[part.type] = part.value
    return found
  }
  return {
    format: (ts, now) => {
      const at = parts(ts)
      const today = parts(now)
      const time = `${at.hour}:${at.minute}`
      const isToday = at.year === today.year && at.month === today.month && at.day === today.day
      return isToday ? time : `${at.month}/${at.day} ${time}`
    },
  }
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`
  return count.toLocaleString('ja-JP')
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function buildFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  try {
    return new Intl.DateTimeFormat('ja-JP', { ...options, timeZone })
  } catch {
    return new Intl.DateTimeFormat('ja-JP', options)
  }
}
