import { expect, test } from 'claude-code/testing'

import { cleanReply, hasAllHeadings, linkPullRequests } from '../hooks/board'
import { buildCards, buildFooter } from '../hooks/history'
import { applyLine, createRecord } from '../hooks/transcript'

const BOARD = `## 目的
- ステータスボードを日本語で表示する
## 判断待ちの事項
- なし
## 現状
- ペインの描画を修正する PR（#12）がレビュー待ち
## 決定事項
- なし
## 次の作業
- なし`

function row(value: unknown): string {
  return JSON.stringify(value)
}

test('人間が入力した指示から system-reminder を除いて記録する', () => {
  const record = createRecord()
  applyLine(
    record,
    row({
      type: 'user',
      timestamp: '2026-11-25T09:00:00.000Z',
      promptSource: 'typed',
      origin: { kind: 'human' },
      message: { role: 'user', content: '<system-reminder>注意</system-reminder>ペインを修正して' },
    }),
  )
  expect(record.events).toEqual([{ kind: 'prompt', ts: Date.parse('2026-11-25T09:00:00.000Z'), text: 'ペインを修正して' }])
})

test('プラグインが追加した入力は指示として記録しない', () => {
  const record = createRecord()
  applyLine(
    record,
    row({
      type: 'user',
      timestamp: '2026-11-25T09:00:00.000Z',
      promptSource: 'system',
      origin: { kind: 'human' },
      message: { role: 'user', content: 'タスクの通知' },
    }),
  )
  expect(record.events).toEqual([])
})

test('計画の advance で実行中の手順が完了し、次の手順が実行中になる', () => {
  const record = createRecord()
  const plan = (input: unknown, ts: string) =>
    applyLine(
      record,
      row({
        type: 'assistant',
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__ccd_turn__update_plan', input }] },
      }),
    )
  plan({ items: [{ content: '調査', status: 'in_progress' }, { content: '実装', status: 'pending' }] }, '2026-11-25T09:00:00.000Z')
  plan({ advance: true }, '2026-11-25T09:10:00.000Z')
  expect(record.plan).toEqual([
    { content: '調査', status: 'completed' },
    { content: '実装', status: 'in_progress' },
  ])
  expect(record.currentSince).toBe(Date.parse('2026-11-25T09:10:00.000Z'))
})

test('同じ番号の PR が 2 つのリポジトリから関連付けられたら、番号にリンクを付けない', () => {
  const record = createRecord()
  applyLine(record, row({ type: 'pr-link', timestamp: '2026-11-25T09:00:00.000Z', prNumber: 12, prUrl: 'https://github.com/a/x/pull/12' }))
  applyLine(record, row({ type: 'pr-link', timestamp: '2026-11-25T09:01:00.000Z', prNumber: 12, prUrl: 'https://github.com/a/y/pull/12' }))
  expect(record.prLinks).toEqual({ '12': null })
})

test('ボードの PR 番号に、関連付けた PR の URL のリンクを付ける', () => {
  const linked = linkPullRequests('- 修正の PR（#12）と `#12` と abc#12', { '12': 'https://github.com/a/x/pull/12' })
  expect(linked).toBe('- 修正の PR（[#12](https://github.com/a/x/pull/12)）と `#12` と abc#12')
})

test('5 つの見出しがそろった要約を受け入れる', () => {
  expect(hasAllHeadings(cleanReply(`\`\`\`markdown\n${BOARD}\n\`\`\``))).toBe(true)
})

test('履歴のカードは指示ごとに分かれ、計画と完了した手順の数を集計する', () => {
  const cards = buildCards([
    { kind: 'prompt', ts: 1, text: 'ペインを修正して' },
    { kind: 'plan', ts: 2, isFresh: true, steps: 3 },
    { kind: 'step', ts: 3, to: 'completed', text: '調査' },
    { kind: 'pr', ts: 4, number: 12, url: 'https://github.com/a/x/pull/12' },
  ])
  expect(cards.map(buildFooter)).toEqual(['計画: 3 手順・完了 1・PR #12'])
})

test('ボードがまだなければ、ペインに作成の案内を表示する', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-25T09:00:00.000Z') }))
  const ui = await $.ui.mount({
    plugin: 'status-board',
    component: 'Pane',
    requestId: 'status-board',
    surface: 'terminal',
    props: {
      title: 'ステータスボード',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })
  expect((await ui.find({ type: 'Text', text: /ステータスボードはまだありません/ }))?.text).toBe(
    'ステータスボードはまだありません。下のボタンで作成できます。',
  )
  await ui.unmount()
})
