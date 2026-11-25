import type { TimelineEvent } from '../types'

type Note = Extract<TimelineEvent, { kind: 'recap' | 'dialog' }>

export type Card = {
  ts: number | null
  prompt: string | null
  notes: Note[]
  planSteps: number | null
  completedSteps: number
  pullRequests: number[]
}

export function buildCards(events: readonly TimelineEvent[]): Card[] {
  const cards: Card[] = []
  let card: Card | null = null
  for (const event of events) {
    if (event.kind === 'prompt') {
      card = { ts: event.ts, prompt: event.text, notes: [], planSteps: null, completedSteps: 0, pullRequests: [] }
      cards.push(card)
      continue
    }
    if (card === null) {
      card = { ts: null, prompt: null, notes: [], planSteps: null, completedSteps: 0, pullRequests: [] }
      cards.push(card)
    }
    switch (event.kind) {
      case 'recap':
      case 'dialog':
        card.notes.push(event)
        break
      case 'plan':
        card.planSteps = event.steps
        break
      case 'step':
        if (event.to === 'completed') card.completedSteps += 1
        break
      case 'pr':
        if (!card.pullRequests.includes(event.number)) card.pullRequests.push(event.number)
        break
    }
  }
  return cards
}

export function buildFooter(card: Card): string | null {
  const parts = [
    card.planSteps === null ? null : `計画: ${card.planSteps} 手順`,
    card.completedSteps === 0 ? null : `完了 ${card.completedSteps}`,
    card.pullRequests.length === 0 ? null : card.pullRequests.map(n => `PR #${n}`).join('、'),
  ].filter(part => part !== null)
  return parts.length === 0 ? null : parts.join('・')
}
