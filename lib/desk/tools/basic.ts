import { z } from 'zod';
import { DESK_COLORS, defineTool } from '../types';
import type { DeskNode, NodePatch } from '../types';

const colorZ = z.enum(DESK_COLORS);
const CHUNK = 20;

/* ------------------------------------------------------------------ */
/* spectrum_shift：色・透明度                                           */
/* ------------------------------------------------------------------ */

function ageBucket(n: DeskNode, now: Date): string {
  const days = (now.getTime() - new Date(n.created_at).getTime()) / 86_400_000;
  if (days < 7) return 'new';
  if (days < 30) return 'mid';
  if (days < 90) return 'old';
  return 'stale';
}
const AGE_COLOR: Record<string, string> = { new: 'emerald', mid: 'cyan', old: 'amber', stale: 'crimson' };

export const spectrumShift = defineTool({
  name: 'spectrum_shift',
  phase: 50,
  description: 'ノードの発光色・透明度を変える。部署別／状態別／経過日数別の自動色分けや、AIの判断による個別配色にも使う',
  argsHint:
    "{ color?: 'cyan'|'blue'|'violet'|'pink'|'crimson'|'orange'|'amber'|'lime'|'emerald'|'slate'（対象に一括適用）, opacity?: 0〜1, by?: 'category'|'status'|'age'（グループごとに自動配色。全ノード対象）, colorMap?: [{ id, color }]（ノード別に色を指定。緊急度順などAI判断の配色） }",
  defaultTarget: 'none',
  argsSchema: z
    .object({
      color: colorZ.nullish(),
      opacity: z.number().min(0).max(1).nullish(),
      by: z.enum(['category', 'status', 'age']).nullish(),
      colorMap: z.array(z.object({ id: z.string(), color: colorZ })).nullish(),
    })
    .refine((a) => a.color || a.opacity != null || a.by || a.colorMap?.length, {
      message: 'color / opacity / by / colorMap のいずれかが必要です',
    }),
  async run(ctx, targets, args) {
    const notes: string[] = [];

    // 1) ノード別の色指定（色ごとにまとめて更新）
    if (args.colorMap?.length) {
      const byColor = new Map<string, string[]>();
      for (const { id, color } of args.colorMap) {
        const real = ctx.realId(id);
        if (real) byColor.set(color, [...(byColor.get(color) ?? []), real]);
      }
      for (const [color, ids] of byColor) await ctx.patchNodes(ids, { color });
      notes.push(`個別配色 ${[...byColor.values()].flat().length}件`);
    }

    // 2) ルールによる自動配色
    if (args.by) {
      const pool = targets.length ? targets : ctx.nodes.filter((n) => !n.metadata?.archived);
      const groups = new Map<string, DeskNode[]>();
      for (const n of pool) {
        const key = args.by === 'category' ? n.category : args.by === 'status' ? n.status : ageBucket(n, ctx.today);
        groups.set(key, [...(groups.get(key) ?? []), n]);
      }
      let i = 0;
      for (const [key, nodes] of groups) {
        const color = args.by === 'age' ? AGE_COLOR[key] : DESK_COLORS[i++ % DESK_COLORS.length];
        await ctx.patchNodes(
          nodes.map((n) => n.id),
          { color }
        );
      }
      notes.push(`${args.by}別に${groups.size}グループへ配色`);
    }

    // 3) 対象への一括の色・透明度
    if ((args.color || args.opacity != null) && targets.length) {
      const patch: NodePatch = {};
      if (args.color) patch.color = args.color;
      if (args.opacity != null) patch.metadata = { opacity: args.opacity };
      await ctx.patchNodes(
        targets.map((n) => n.id),
        patch
      );
      notes.push(`${targets.length}件を更新`);
    }

    return notes.length ? `spectrum_shift: ${notes.join(' / ')}` : 'spectrum_shift: 対象ノードなし';
  },
});

/* ------------------------------------------------------------------ */
/* zoom：フォーカス（手前に強調し、他を薄くする）                          */
/* ------------------------------------------------------------------ */

export const zoom = defineTool({
  name: 'zoom',
  phase: 45, // 元の実行順（zoom → spectrum_shift）を維持
  description: '条件に合うノードを強調して、ほかのノードを薄くする。解除（元に戻す）にも使う',
  argsHint:
    '{ focus?: boolean（既定true。falseで対象の強調を外す）, dimOthers?: boolean（既定true。対象外を薄くする）, reset?: boolean（trueで全ノードの強調・薄め表示を解除。対象指定は不要） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    focus: z.boolean().nullish(),
    dimOthers: z.boolean().nullish(),
    reset: z.boolean().nullish(),
  }),
  async run(ctx, targets, args) {
    if (args.reset) {
      const highlighted = ctx.nodes.filter((n) => n.status === 'highlight').map((n) => n.id);
      await ctx.patchNodes(
        ctx.nodes.map((n) => n.id),
        { metadata: { opacity: null } }
      );
      await ctx.patchNodes(highlighted, { status: 'normal' });
      return 'zoom: フォーカスを解除';
    }
    if (!targets.length) return 'zoom: 対象ノードなし';

    const focus = args.focus ?? true;
    const ids = targets.map((n) => n.id);
    await ctx.patchNodes(ids, { status: focus ? 'highlight' : 'normal', metadata: { opacity: null } });

    if (focus && (args.dimOthers ?? true)) {
      const set = new Set(ids);
      const others = ctx.nodes.filter((n) => !set.has(n.id) && !n.metadata?.archived);
      await ctx.patchNodes(
        others.map((n) => n.id),
        { metadata: { opacity: 0.25 } }
      );
      await ctx.patchNodes(
        others.filter((n) => n.status === 'highlight').map((n) => n.id),
        { status: 'normal' }
      );
    }
    return `zoom: ${ids.length}件にフォーカス`;
  },
});

/* ------------------------------------------------------------------ */
/* auto_tag：タグ・期限の付与（文面はAIが考える）                         */
/* ------------------------------------------------------------------ */

export const autoTag = defineTool({
  name: 'auto_tag',
  phase: 30,
  description: 'ノードにタグや期限(YYYY-MM-DD)を付ける。本文から期限を読み取って付けるのにも使う（時期ごとの並べ替えの前処理）',
  argsHint:
    '{ tags?: string[]（対象全部に同じタグを付ける）, remove?: string[]（対象からこのタグを外す）, assignments?: [{ id, tags?: string[], due?: "YYYY-MM-DD" }]（ノード別に付ける）, replace?: boolean（trueで既存タグを置き換え） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    tags: z.array(z.string()).nullish(),
    assignments: z
      .array(z.object({ id: z.string(), tags: z.array(z.string()).nullish(), due: z.string().nullish() }))
      .nullish(),
    replace: z.boolean().nullish(),
    remove: z.array(z.string()).nullish(),
  }),
  async run(ctx, targets, args) {
    const byId = new Map(ctx.nodes.map((n) => [n.id, n] as const));
    const work = new Map<string, { tags: string[]; due?: string }>();
    const removal = new Set((args.remove ?? []).map((t) => t.replace(/^@/, '').trim()).filter(Boolean));
    if (removal.size) for (const n of targets) work.set(n.id, { tags: [] });

    if (args.tags?.length) for (const n of targets) work.set(n.id, { tags: args.tags });
    for (const a of args.assignments ?? []) {
      const id = ctx.realId(a.id);
      if (!id || !byId.has(id)) continue;
      const prev = work.get(id);
      work.set(id, { tags: [...(prev?.tags ?? []), ...(a.tags ?? [])], due: a.due ?? prev?.due });
    }
    if (!work.size) return 'auto_tag: 付与するタグ・期限の指定なし';

    const entries = [...work.entries()];
    for (let i = 0; i < entries.length; i += CHUNK) {
      await Promise.all(
        entries.slice(i, i + CHUNK).map(async ([id, w]) => {
          const n = byId.get(id)!;
          const base = args.replace ? [] : Array.isArray(n.metadata.tags) ? n.metadata.tags.map(String) : [n.category];
          let tags = [...new Set([...base, ...w.tags.map((t) => t.trim()).filter(Boolean)])].filter((t) => !removal.has(t));
          if (tags.length === 0) tags = [n.category];
          const metadata: Record<string, any> = { tags };
          if (w.due && /^\d{4}-\d{2}-\d{2}$/.test(w.due)) metadata.due = w.due;
          await ctx.patchNodes([id], { metadata });
        })
      );
    }
    return `auto_tag: ${work.size}件にタグ/期限を付与`;
  },
});

/* ------------------------------------------------------------------ */
/* diagnostic_scan：スキャン／コメントモード                             */
/* ------------------------------------------------------------------ */

export const diagnosticScan = defineTool({
  name: 'diagnostic_scan',
  phase: 70,
  description: '対象ノードをスキャン状態にしてコメントモードをON/OFFする。矛盾・前提抜け・リスクの指摘コメントを付けることもできる',
  argsHint:
    "{ status?: 'scanned'|'normal'（既定scanned）, commentMode?: boolean（既定は status=scannedならtrue、normalならfalse）, findings?: [{ id, comment }]（AIが見つけた指摘。ノード別・短文） }",
  defaultTarget: 'none',
  argsSchema: z.object({
    status: z.enum(['scanned', 'normal']).nullish(),
    commentMode: z.boolean().nullish(),
    findings: z.array(z.object({ id: z.string(), comment: z.string() })).nullish(),
  }),
  async run(ctx, targets, args) {
    const status = args.status ?? 'scanned';
    const commentMode = args.commentMode ?? status !== 'normal';
    let count = 0;

    if (targets.length) {
      await ctx.patchNodes(
        targets.map((n) => n.id),
        { status, metadata: { commentMode } }
      );
      count = targets.length;
    }
    for (const f of args.findings ?? []) {
      const id = ctx.realId(f.id);
      if (!id) continue;
      await ctx.patchNodes([id], { status: 'scanned', metadata: { commentMode: true, comment: f.comment } });
      count++;
    }
    return count ? `diagnostic_scan: ${count}件（コメントモード${commentMode ? 'ON' : 'OFF'}）` : 'diagnostic_scan: 対象ノードなし';
  },
});

