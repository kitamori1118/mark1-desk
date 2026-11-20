import { z } from 'zod';
import { defineTool } from '../types';
import type { ToolContext } from '../types';

/* AIが「内容そのもの」を書くツール。プランを作る1回のAI呼び出しの中で文面まで書かせるので、追加のAPI呼び出しは増えない。
   生成内容は固定されるため、マクロ（AIを介さない再実行）には保存できない（replayable: false）。 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* rewrite_node：書き直し                                               */
/* ------------------------------------------------------------------ */

export const rewriteNode = defineTool({
  name: 'rewrite_node',
  phase: 15,
  replayable: false,
  description: 'ノードの本文を書き直す。「整えて」「短くして」「誤字直して」「わかりやすく言い換えて」「要約して置き換えて」に使う',
  argsHint: '{ rewrites: [{ id, content }]（最大30件。content は書き直した本文。意味を変えず、元と同じ言語で簡潔に） }',
  defaultTarget: 'none',
  argsSchema: z.object({ rewrites: z.array(z.object({ id: z.string(), content: z.string().min(1) })).min(1).max(30) }),
  async run(ctx, _targets, args) {
    let n = 0;
    for (const r of args.rewrites) {
      const id = ctx.realId(r.id);
      const content = r.content.trim();
      if (!id || !content) continue;
      await ctx.patchNodes([id], { content });
      n++;
    }
    return n ? `rewrite_node: ${n}件を書き直し` : 'rewrite_node: 書き直せるノードなし';
  },
});

/* ------------------------------------------------------------------ */
/* extract_actions / expand_ideas：新しいノードをAIが生む                 */
/* ------------------------------------------------------------------ */

async function spawn(
  ctx: ToolContext,
  items: { sourceId?: string | null; content: string; due?: string | null }[],
  base: { category: string; color: string; tags: string[]; stage?: string }
) {
  const rows = items
    .filter((a) => a.content.trim())
    .map((a) => {
      const src = a.sourceId ? ctx.realId(a.sourceId) : null;
      const meta: Record<string, any> = { tags: base.tags, ai: true };
      if (base.stage) meta.stage = base.stage;
      if (a.due && DAY_RE.test(a.due)) meta.due = a.due;
      if (src) meta.sources = [src]; // 元ノードへの点線として表示される
      return { content: a.content.trim(), category: base.category, color: base.color, metadata: meta };
    });
  await ctx.insertNodes(rows);
  return rows.length;
}

export const extractActions = defineTool({
  name: 'extract_actions',
  phase: 38,
  replayable: false,
  description: 'ノードの内容から「やるべきこと（ToDo）」を抽出して、新しいタスクノードとして生成する。期限があれば付ける',
  argsHint:
    '{ actions: [{ sourceId?: 元ノードのid, content: 具体的な行動を1つ（動詞で終わる短文）, due?: "YYYY-MM-DD" }]（最大15件） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    actions: z
      .array(z.object({ sourceId: z.string().nullish(), content: z.string().min(1), due: z.string().nullish() }))
      .min(1)
      .max(15),
  }),
  async run(ctx, _targets, args) {
    const n = await spawn(ctx, args.actions, { category: 'タスク', color: 'emerald', tags: ['TODO'], stage: '未着手' });
    return `extract_actions: ${n}件のタスクを生成`;
  },
});

export const expandIdeas = defineTool({
  name: 'expand_ideas',
  phase: 39,
  replayable: false,
  description: 'ノードやテーマからアイデアを広げ、新しいアイデアノードとして生成する（ブレインストーミング・派生案・別案）',
  argsHint: '{ ideas: [{ sourceId?: 元ノードのid, content: 新しい案を1つ（簡潔に） }]（最大12件） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    ideas: z.array(z.object({ sourceId: z.string().nullish(), content: z.string().min(1) })).min(1).max(12),
  }),
  async run(ctx, _targets, args) {
    const n = await spawn(ctx, args.ideas, { category: 'アイデア', color: 'amber', tags: ['AI案'] });
    return `expand_ideas: ${n}件のアイデアを生成`;
  },
});

/* ------------------------------------------------------------------ */
/* report：質問への回答・要約・状況報告（DBは変えない）                    */
/* ------------------------------------------------------------------ */

export const report = defineTool({
  name: 'report',
  phase: 95,
  replayable: false,
  description:
    '質問に答える・全体を要約する・状況報告やブリーフィング（今日やること、遅れているもの、傾向の分析）を出す。データは変更せず、画面に回答パネルを出す。Current Nodes に書かれている情報だけを根拠にする',
  argsHint: '{ title?: string, text: string（回答本文。日本語、箇条書き可、600字以内。根拠のノードは内容で言及する） }',
  defaultTarget: 'none',
  argsSchema: z.object({ title: z.string().nullish(), text: z.string().min(1) }),
  async run(ctx, _targets, args) {
    ctx.reports.push(args.title ? `■ ${args.title}\n${args.text.trim()}` : args.text.trim());
    return 'report: 回答を表示します';
  },
});
