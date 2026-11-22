import { z } from 'zod';
import { defineTool } from '../types';
import type { DeskNode } from '../types';
import { nodeTags } from '../selector';

/*
 * 重ねる（スタック）：複数のオーブを1か所に積み重ね、まとめて動かせるようにする。
 * 「どれが同じ山か」は metadata.stack（山のID）に保存する。位置は端末側が持つので、
 * 実際に積む／ばらす動きは ui 指令として画面側に伝える。
 */

const newId = (i: number) => `s${Date.now().toString(36)}${i}`;

export const stackNodes = defineTool({
  name: 'stack_nodes',
  phase: 57,
  description:
    'ノードを1か所に重ねて山にし、まとめて動かせるようにする（スタック）。「〇〇を重ねて」「カテゴリごとに重ねて」。重ねたものはドラッグすると一緒に動く。ばらすのは unstack',
  argsHint: "{ by?: 'category'|'tag'|'stage'|'color'|'status'（グループごとに別の山にする。省略すると target 全部で1つの山） }",
  defaultTarget: 'none',
  argsSchema: z.object({ by: z.enum(['category', 'tag', 'stage', 'color', 'status']).nullish() }),
  async run(ctx, targets, args) {
    if (targets.length < 2) return 'stack_nodes: 重ねるノードが2件以上ありません';
    const keyOf = (n: DeskNode) =>
      args.by === 'category' ? n.category : args.by === 'color' ? n.color : args.by === 'status' ? n.status
      : args.by === 'stage' ? (n.metadata?.stage as string) || '(未設定)' : args.by === 'tag' ? nodeTags(n)[0] ?? '(タグなし)' : 'all';
    const buckets = new Map<string, DeskNode[]>();
    for (const n of targets) buckets.set(keyOf(n), [...(buckets.get(keyOf(n)) ?? []), n]);
    const groups = [...buckets.values()].filter((g) => g.length >= 2).map((g, i) => ({ id: newId(i), ids: g.map((n) => n.id) }));
    if (!groups.length) return 'stack_nodes: 重ねられるグループがありません（各グループ2件以上が必要）';
    for (const g of groups) await ctx.patchNodes(g.ids, { metadata: { stack: g.id } });
    ctx.ui.push({ type: 'stack', groups });
    const total = groups.reduce((a, g) => a + g.ids.length, 0);
    return `stack_nodes: ${total}件を${groups.length}つの山に重ねました`;
  },
});

export const unstackNodes = defineTool({
  name: 'unstack',
  phase: 58,
  description: '重ねてある山をばらして広げる（スタックの解除）。「ばらして」「スタックを解除」。山の一部だけ指定すると、その山全体を解除する',
  argsHint: '{}',
  defaultTarget: 'none',
  argsSchema: z.object({}),
  async run(ctx, targets) {
    const stacks = new Set(targets.map((n) => n.metadata?.stack as string).filter(Boolean));
    const members = ctx.nodes.filter((n) => n.metadata?.stack && stacks.has(n.metadata.stack as string));
    if (!members.length) return 'unstack: 重なっているノードがありません';
    await ctx.patchNodes(
      members.map((n) => n.id),
      { metadata: { stack: null } }
    );
    ctx.ui.push({ type: 'spread', ids: members.map((n) => n.id) });
    return `unstack: ${members.length}件の重なりをばらしました`;
  },
});
