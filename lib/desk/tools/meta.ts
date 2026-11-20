import { z } from 'zod';
import { defineTool } from '../types';
import { daysUntil, dueOf } from '../selector';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 20;

/* ------------------------------------------------------------------ */
/* pin / archive                                                       */
/* ------------------------------------------------------------------ */

export const pinNodes = defineTool({
  name: 'pin',
  phase: 52,
  description: 'ノードをピン留めする（一覧・グループ表示で先頭に来る）。解除にも使う',
  argsHint: '{ pinned?: boolean（既定true。falseで解除） }',
  defaultTarget: 'none',
  argsSchema: z.object({ pinned: z.boolean().nullish() }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'pin: 対象ノードなし';
    const on = args.pinned ?? true;
    await ctx.patchNodes(
      targets.map((n) => n.id),
      { metadata: { pinned: on ? true : null } }
    );
    return `pin: ${targets.length}件を${on ? 'ピン留め' : 'ピン解除'}`;
  },
});

export const archiveNodes = defineTool({
  name: 'archive',
  phase: 54,
  description:
    '終わったもの・不要なものを消さずにしまう（画面と通常の対象から外れる）。復元にも使う。復元するときは target.filter.archived=true で対象を指定する',
  argsHint: '{ restore?: boolean（trueでアーカイブから戻す） }',
  defaultTarget: 'none',
  argsSchema: z.object({ restore: z.boolean().nullish() }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'archive: 対象ノードなし';
    const restore = !!args.restore;
    await ctx.patchNodes(
      targets.map((n) => n.id),
      { metadata: { archived: restore ? null : true } }
    );
    return `archive: ${targets.length}件を${restore ? '復元' : 'アーカイブ'}`;
  },
});

/* ------------------------------------------------------------------ */
/* set_due / set_stage                                                 */
/* ------------------------------------------------------------------ */

export const setDue = defineTool({
  name: 'set_due',
  phase: 31,
  description: 'ノードの期限(YYYY-MM-DD)を設定・変更・解除する。本文の日付表現（「来週金曜まで」等）を今日の日付から計算して入れる',
  argsHint:
    '{ due?: "YYYY-MM-DD"（targetの全ノードに同じ期限）, clear?: boolean（期限を外す）, assignments?: [{ id, due: "YYYY-MM-DD"|null }]（ノード別。nullで解除） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    due: z.string().nullish(),
    clear: z.boolean().nullish(),
    assignments: z.array(z.object({ id: z.string(), due: z.string().nullish() })).max(60).nullish(),
  }),
  async run(ctx, targets, args) {
    const work = new Map<string, string | null>();
    if (args.clear) targets.forEach((n) => work.set(n.id, null));
    else if (args.due && DAY_RE.test(args.due)) targets.forEach((n) => work.set(n.id, args.due as string));
    for (const a of args.assignments ?? []) {
      const id = ctx.realId(a.id);
      if (!id) continue;
      if (!a.due) work.set(id, null);
      else if (DAY_RE.test(a.due)) work.set(id, a.due);
    }
    if (!work.size) return 'set_due: 設定する期限なし';
    const entries = [...work.entries()];
    for (let i = 0; i < entries.length; i += CHUNK) {
      await Promise.all(entries.slice(i, i + CHUNK).map(([id, due]) => ctx.patchNodes([id], { metadata: { due } })));
    }
    return `set_due: ${work.size}件の期限を更新`;
  },
});

export const setStage = defineTool({
  name: 'set_stage',
  phase: 32,
  description: 'ノードの進行ステージ（未着手／進行中／完了 など）を設定する。カンバン表示（group_view by=stage）の前処理にも使う',
  argsHint: '{ stage?: string（targetの全ノードに設定。例: "未着手" "進行中" "完了"）, clear?: boolean, assignments?: [{ id, stage }]（ノード別。AIが内容から判断） }',
  defaultTarget: 'none',
  argsSchema: z.object({
    stage: z.string().nullish(),
    clear: z.boolean().nullish(),
    assignments: z.array(z.object({ id: z.string(), stage: z.string() })).max(60).nullish(),
  }),
  async run(ctx, targets, args) {
    const work = new Map<string, string | null>();
    if (args.clear) targets.forEach((n) => work.set(n.id, null));
    else if (args.stage?.trim()) targets.forEach((n) => work.set(n.id, args.stage!.trim()));
    for (const a of args.assignments ?? []) {
      const id = ctx.realId(a.id);
      if (id && a.stage.trim()) work.set(id, a.stage.trim());
    }
    if (!work.size) return 'set_stage: 設定するステージなし';
    const entries = [...work.entries()];
    for (let i = 0; i < entries.length; i += CHUNK) {
      await Promise.all(entries.slice(i, i + CHUNK).map(([id, stage]) => ctx.patchNodes([id], { metadata: { stage } })));
    }
    return `set_stage: ${work.size}件のステージを更新`;
  },
});

/* ------------------------------------------------------------------ */
/* deadline_alert：期限が近い／過ぎたノードを警告表示                      */
/* ------------------------------------------------------------------ */

export const deadlineAlert = defineTool({
  name: 'deadline_alert',
  phase: 75,
  description: '期限が近い／過ぎたノードを警告色にして、残り日数のコメントを付ける（完了ステージは除く）。「期限ヤバいの教えて」に使う',
  argsHint: '{ withinDays?: number（既定3。この日数以内を警告）, commentMode?: boolean（既定true。残り日数コメントを出す） }',
  defaultTarget: 'all',
  argsSchema: z.object({ withinDays: z.number().min(0).max(365).nullish(), commentMode: z.boolean().nullish() }),
  async run(ctx, targets, args) {
    const within = args.withinDays ?? 3;
    const comment = args.commentMode ?? true;
    const hits: { id: string; color: string; note: string }[] = [];
    for (const n of targets) {
      const due = dueOf(n);
      if (!due || n.metadata?.stage === '完了') continue;
      const left = daysUntil(due, ctx.today);
      if (Number.isNaN(left) || left > within) continue;
      hits.push({
        id: n.id,
        color: left < 0 ? 'crimson' : 'amber',
        note: left < 0 ? `期限超過${-left}日` : left === 0 ? '今日が期限' : `あと${left}日`,
      });
    }
    for (let i = 0; i < hits.length; i += CHUNK) {
      await Promise.all(
        hits.slice(i, i + CHUNK).map((h) =>
          ctx.patchNodes([h.id], {
            color: h.color,
            status: 'scanned',
            metadata: comment ? { commentMode: true, comment: h.note } : {},
          })
        )
      );
    }
    const over = hits.filter((h) => h.color === 'crimson').length;
    return hits.length ? `deadline_alert: 期限超過${over}件 / 間近${hits.length - over}件` : 'deadline_alert: 期限が迫っているノードなし';
  },
});

/* ------------------------------------------------------------------ */
/* delete_nodes：削除（↶ 戻す で復元できる）                              */
/* ------------------------------------------------------------------ */

export const deleteNodes = defineTool({
  name: 'delete_nodes',
  phase: 56,
  replayable: false,
  description:
    'ノードを完全に削除する（実行後に「↶ 戻す」で復元できる）。「〇〇を削除して」「完了したものを消して」に使う。しまっておきたいだけなら archive を使う。何を消すかは、内容を読んで target.ids で明示する',
  argsHint: '{ all?: boolean（今あるノードを全部消すと明確に頼まれたときだけ true） }',
  defaultTarget: 'none',
  argsSchema: z.object({ all: z.boolean().nullish() }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'delete_nodes: 削除する対象なし（指令に合うノードが見つかりません）';
    const live = ctx.nodes.filter((n) => !n.metadata?.archived).length;
    if (targets.length >= live && live > 3 && !args.all) {
      return `delete_nodes: 全${live}件の削除になるため中止しました（本当に全部消すなら「全部削除して」と指令してください）`;
    }
    const gone = new Set(targets.map((n) => n.id));
    await ctx.deleteNodes([...gone]);

    // 消えたノードへの線も外しておく
    for (const n of ctx.nodes) {
      const links = Array.isArray(n.metadata?.links) ? (n.metadata.links as string[]) : [];
      const keep = links.filter((id) => !gone.has(id));
      if (keep.length !== links.length) await ctx.patchNodes([n.id], { metadata: { links: keep.length ? keep : null } });
    }
    return `delete_nodes: ${gone.size}件を削除（↶ 戻す で復元できます）`;
  },
});
