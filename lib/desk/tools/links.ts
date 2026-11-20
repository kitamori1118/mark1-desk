import { z } from 'zod';
import { defineTool } from '../types';
import type { DeskNode, ToolContext } from '../types';

/* 線は metadata.links（そのノードから出る線の相手ID配列）に保存する。1組につき1本だけ持つ */

const pairZ = z.object({ from: z.string(), to: z.string() });
const linksOf = (n: DeskNode): string[] => (Array.isArray(n.metadata?.links) ? n.metadata.links.map(String) : []);

export const linkNodes = defineTool({
  name: 'link_nodes',
  phase: 35,
  description:
    'ノード同士を線でつなぐ（関連づけ）。「関連するものをつないで」「AとBを結んで」「全部を〇〇につなげて」に使う。関連の判断はAIが内容を読んで行う',
  argsHint:
    '{ pairs?: [{ from, to }]（関連ありと判断した組。最大30組）, chain?: boolean（targetを順に1本ずつつなぐ）, hub?: string（targetの各ノードをこの中心ノードにつなぐ） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    pairs: z.array(pairZ).max(30).nullish(),
    chain: z.boolean().nullish(),
    hub: z.string().nullish(),
  }),
  async run(ctx, targets, args) {
    const wanted: [string, string][] = [];
    for (const p of args.pairs ?? []) {
      const a = ctx.realId(p.from);
      const b = ctx.realId(p.to);
      if (a && b && a !== b) wanted.push([a, b]);
    }
    if (args.chain) for (let i = 1; i < targets.length; i++) wanted.push([targets[i - 1].id, targets[i].id]);
    const hub = args.hub ? ctx.realId(args.hub) : null;
    if (hub) for (const n of targets) if (n.id !== hub) wanted.push([n.id, hub]);

    const byId = new Map(ctx.nodes.map((n) => [n.id, n] as const));
    const next = new Map<string, Set<string>>();
    let added = 0;
    // この呼び出しの中で追加した線も含めて判定する（同じ組・逆向きの重複を防ぐ）
    const current = (id: string) => next.get(id) ?? new Set(linksOf(byId.get(id)!));
    for (const [a, b] of wanted) {
      if (!byId.has(a) || !byId.has(b)) continue;
      if (current(b).has(a)) continue; // 逆向きで既に結ばれている
      const set = current(a);
      if (!set.has(b)) {
        set.add(b);
        added++;
      }
      next.set(a, set);
    }
    for (const [id, set] of next) await ctx.patchNodes([id], { metadata: { links: [...set] } });
    return added ? `link_nodes: ${added}本の線を追加` : 'link_nodes: つなぐ組なし（または既に接続済み）';
  },
});

async function removeLinks(ctx: ToolContext, shouldRemove: (from: string, to: string) => boolean): Promise<number> {
  let removed = 0;
  for (const n of ctx.nodes) {
    const cur = linksOf(n);
    if (!cur.length) continue;
    const keep = cur.filter((to) => !shouldRemove(n.id, to));
    if (keep.length === cur.length) continue;
    removed += cur.length - keep.length;
    await ctx.patchNodes([n.id], { metadata: { links: keep.length ? keep : null } });
  }
  return removed;
}

export const unlinkNodes = defineTool({
  name: 'unlink',
  phase: 36,
  description: 'ノード間の線を外す。「AとBの線を消して」「このノードの接続を全部外して」',
  argsHint: '{ pairs?: [{ from, to }]（向きは問わない）, all?: boolean（targetに触れている線を全部外す） }',
  defaultTarget: 'none',
  argsSchema: z.object({ pairs: z.array(pairZ).max(30).nullish(), all: z.boolean().nullish() }),
  async run(ctx, targets, args) {
    const ids = new Set(targets.map((n) => n.id));
    const pairs = (args.pairs ?? [])
      .map((p) => [ctx.realId(p.from), ctx.realId(p.to)] as const)
      .filter((p): p is readonly [string, string] => !!p[0] && !!p[1]);
    const n = await removeLinks(ctx, (from, to) => {
      if (args.all && (ids.has(from) || ids.has(to))) return true;
      return pairs.some(([a, b]) => (a === from && b === to) || (a === to && b === from));
    });
    return n ? `unlink: ${n}本の線を外しました` : 'unlink: 外す線なし';
  },
});
