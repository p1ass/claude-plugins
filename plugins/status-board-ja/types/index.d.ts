export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = { content: string; status: StepStatus }

export type TimelineEvent =
  | { kind: 'prompt'; ts: number; text: string }
  | { kind: 'dialog'; ts: number; text: string; more: number }
  | { kind: 'recap'; ts: number; text: string; ask: string | null }
  | { kind: 'plan'; ts: number; isFresh: boolean; steps: number }
  | { kind: 'step'; ts: number; to: StepStatus; text: string }
  | { kind: 'pr'; ts: number; number: number; url: string }

export type SessionRecord = {
  events: TimelineEvent[]
  plan: PlanStep[]
  currentSince: number | null
  prLinks: Record<string, string | null>
}

export type Board = {
  summary: string
  at: number
  inputTokens: number
  outputTokens: number
}

export type Activity = {
  isTurnRunning: boolean
  lastTurnEndedAt: number | null
  lastActivityAt: number
}

export type PaneView = {
  isHistoryShown: boolean
  isAllShown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'status-board-ja': {
      record: Shaped<SessionRecord>
      board: Shaped<Board | null>
      activity: Activity
      isSummarizing: boolean
      view: PaneView
      failure: string | null
    }
  }
}
