import { z } from 'zod';
import { defineTool } from '../types';
import type { DeskNode } from '../types';
import { nodeTags } from '../selector';

const time = (s: string) => {
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/* ------------------------------------------------------------------ */
/* merge_duplicates：重複統合（統合後の文面はAIが書く）                    */
/* ------------------------------------------------------------------ */

export const mergeDuplicates = defineTool({
  name: 'merge_duplicates',
  phase: 10,
  description: '重複・類似ノードを1つに融合する。複数の重複グループをまとめて統合できる',
  argsHint:
    '{ groups?: [{ ids: string[], mergedContent?: string }]（重複グループごとの統合。mergedContentは統合後の文面を簡潔に）, mergedContent?: string（target の全ノードを1つに統合するとき） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    mergedContent: z.string().nullish(),
    groups: z.array(z.object({ ids: z.array(z.string()), mergedContent: z.string().nullish() })).nullish(),
  }),
  async run(ctx, targets, args) {
    const byId = new Map(ctx.nodes.map((n) => [n.id, n] as const));
    const groups: { nodes: DeskNode[]; content?: string | null }[] = [];

    if (args.groups?.length) {
      for (const g of args.groups) {
        const nodes = [...new Set(g.ids.map((id) => ctx.realId(id)).filter((x): x is string => !!x))]
          .map((id) => byId.get(id))
          .filter((n): n is DeskNode => !!n);
        groups.push({ nodes, content: g.mergedContent });
      }
    } else {
      groups.push({ nodes: targets, content: args.mergedContent });
    }

    let merged = 0;
    for (const g of groups) {
      if (g.nodes.length < 2) continue;
      const sorted = [...g.nodes].sort((a, b) => time(a.created_at) - time(b.created_at));
      const [primary, ...rest] = sorted;
      const content = g.content?.trim() || `【統合】: ${sorted.map((n) => n.content).join(' / ')}`;
      const tags = [...new Set(sorted.flatMap((n) => nodeTags(n)))];

      await ctx.patchNodes([primary.id], { content, status: 'highlight', metadata: { tags } });
      await ctx.deleteNodes(rest.map((n) => n.id));
      merged++;
    }
    return merged ? `merge_duplicates: ${merged}グループを統合` : 'merge_duplicates: 統合できる2件以上の対象なし';
  },
});

/* ------------------------------------------------------------------ */
/* split：分解（分け方はAIが決める。指定が無ければ区切り文字で分ける）       */
/* ------------------------------------------------------------------ */

const MAX_SPLIT_TARGETS = 20;

export const splitNode = defineTool({
  name: 'split',
  phase: 20,
  description: '情報量の多いノードを「1アイデア＝1ノード」に分解する',
  argsHint:
    '{ splits?: [{ id, parts: string[] }]（ノードごとの分解結果。各partは短い1アイデア） }。splits が無い対象は区切り文字（／ , 、 改行）で機械的に分ける',
  defaultTarget: 'none',
  argsSchema: z.object({
    splits: z.array(z.object({ id: z.string(), parts: z.array(z.string()) })).nullish(),
  }),
  async run(ctx, targets, args) {
    const byId = new Map(ctx.nodes.map((n) => [n.id, n] as const));
    const given = new Map<string, string[]>();
    for (const s of args.splits ?? []) {
      const id = ctx.realId(s.id);
      if (id) given.set(id, s.parts);
    }

    // target 未指定でも splits に出てくるノードは対象にする
    const pool = targets.length ? targets : [...given.keys()].map((id) => byId.get(id)).filter((n): n is DeskNode => !!n);

    let done = 0;
    for (const node of pool.slice(0, MAX_SPLIT_TARGETS)) {
      const raw = given.get(node.id) ?? node.content.split(/[／/、,\n]+/);
      const parts = raw.map((p) => p.trim()).filter(Boolean);
      if (parts.length <= 1) continue;

      // コメント類は分解先に引き継がない
      const { comment: _c, commentMode: _m, ...meta } = node.metadata;
      await ctx.insertNodes(
        parts.map((content) => ({ content, category: node.category, color: node.color, metadata: { ...meta } }))
      );
      await ctx.deleteNodes([node.id]); // 先に挿入してから削除（途中失敗でも消えない）
      done++;
    }
    return done ? `split: ${done}件のノードを分解` : 'split: 分解できる対象なし';
  },
});

/* ------------------------------------------------------------------ */
/* crystallize_core：親ノード（まとめ結晶）の生成                         */
/* ------------------------------------------------------------------ */

export const crystallizeCore = defineTool({
  name: 'crystallize_core',
  phase: 40,
  description: '複数ノードを要約・構造化して、新しい親ノード（コア）を生成する。元ノードは残す',
  argsHint: '{ summary?: string（コアに入れる要約。2〜3文以内で簡潔に） }',
  defaultTarget: 'none',
  argsSchema: z.object({ summary: z.string().nullish() }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'crystallize_core: 対象ノードなし';
    const body = args.summary?.trim() || targets.map((n) => n.content).join(' ⇄ ');
    await ctx.insertNodes([
      {
        content: `【構造化コア】: ${body}`,
        category: 'core',
        color: 'amber',
        status: 'highlight',
        // sources は将来「コア→元ノード」の線接続に使える
        metadata: { tags: ['core'], sources: targets.map((n) => n.id) },
      },
    ]);
    return `crystallize_core: ${targets.length}件からコアを生成`;
  },
});
