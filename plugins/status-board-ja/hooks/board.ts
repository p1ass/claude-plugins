export const HEADINGS = ['目的', '判断待ちの事項', '現状', '決定事項', '次の作業'] as const

export const SUMMARY_PROMPT = `この会話の現在までの内容を、このセッションのステータスボードに要約してください。
読者はこの会話を読んでいません。読者がボードだけで現状を把握し、次に判断する事項を特定できることが目的です。短さは目的ではありません。
現在はツールを使用できません。検討の過程、前置き、結びの言葉は出力せず、回答だけを直ちに出力してください。

ボードでは、読者を「あなた」、この会話のアシスタントを「モデル」と呼びます。次のルールで記述してください。

- 会話の中で付けた名前（案の名前、略語、作業の通称）と、PR や Issue の番号は、単独で記述しない。初出では対象の内容を先に記述し、名前や番号を括弧で添える。コミットのハッシュは記述しない。
  - 悪い例: 「案 B で進める」
  - 良い例: 「在庫を夜間の一括処理で更新する方式（案 B）で進める」
  - 悪い例: 「#12 がレビュー待ち」
  - 良い例: 「検索結果の並び順を修正する PR（#12）がレビュー待ち」
- 1 項目には 1 つの事柄を 1〜2 文で記述する。判断待ちの項目は 3 文まで記述してよい。
- 各項目は結論か状態から始め、その項目だけで意味が通るように記述する。「上記」「先ほど」のような、ほかの箇所を指す語は使わない。
- モデルが完了した作業には、確認の方法を添える（「テストを実行して確認済み」「未実行」など）。
- 会話で述べられた事実だけを記述する。見込みと未確認の事項は、「見込み」「未確認」と明記する。会話にない選択肢、推奨、手順は追加しない。
- 決定事項には、決定の理由を同じ項目に記述する。
- 和語より適切な熟語があれば熟語を使う（「決める」ではなく「決定する」、「作る」ではなく「作成する」）。カタカナ語のほうが一般的な概念はカタカナで記述する。
- 1 文には 1 つの事柄だけを記述する。名詞を「の」で 3 つ以上連ねない。
- 条件は肯定の文で、条件、結果の順に記述する。
- 全体を 1,200 字程度に収める。超える場合は、項目の記述を削らず、重要度の低い項目を省く。判断待ちの項目は最後まで残す。

出力の形式は次のとおりです。見出しの文言と順序は変更しないでください。該当する項目がない見出しには「- なし」と記述してください。

## 目的
- このセッションで達成する事柄
## 判断待ちの事項
- あなたの回答や判断を待っている質問。モデルが選択肢を提示していれば、選択肢と推奨を含める
## 現状
- 完了した作業と、実行中の作業
## 決定事項
- 会話で決定した事項と、その理由
## 次の作業
- 次にモデルかあなたが実施する作業`

export function cleanReply(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[\w-]*\n([\s\S]*)\n```$/.exec(trimmed)
  const body = (fenced?.[1] ?? trimmed).trim()
  const first = body.indexOf('## ')
  return first > 0 ? body.slice(first) : body
}

export function hasAllHeadings(board: string): boolean {
  return listHeadings(board).join('\n') === HEADINGS.join('\n')
}

export function linkPullRequests(board: string, links: Readonly<Record<string, string | null>>): string {
  let fence: string | null = null
  return board
    .split('\n')
    .map(line => {
      if (fence !== null) {
        if (line.trim().startsWith(fence)) fence = null
        return line
      }
      const opening = /^\s*(`{3,}|~{3,})/.exec(line)
      if (opening?.[1]) {
        fence = opening[1]
        return line
      }
      if (/^\s{0,3}\[[^\]]+\]:\s/.test(line)) return line
      return linkLine(line, links)
    })
    .join('\n')
}

function linkLine(line: string, links: Readonly<Record<string, string | null>>): string {
  return line
    .split(/(`[^`]*`|\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\[[^\]]*\]|https?:\/\/\S+)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/(^|[^\w/#&])#(\d+)(?![\w])/g, (whole, lead: string, number: string) => {
            const url = links[number]
            return typeof url === 'string' ? `${lead}[#${number}](${url})` : whole
          }),
    )
    .join('')
}

function listHeadings(board: string): string[] {
  return board
    .split('\n')
    .filter(line => line.startsWith('## '))
    .map(line => line.slice(3).trim())
}
