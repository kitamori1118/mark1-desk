import type { SupabaseClient } from '@supabase/supabase-js';
import { getTool } from './desk/registry';
import { resolveTargets } from './desk/selector';
import { recordOp } from './desk/ops';
import type { DeskNode, ExecutionPlan, NewNode, NodePatch, PlanItem, ToolContext, ToolDef } from './desk/types';

// 既存コードとの互換用
export type { ExecutionPlan, PlanItem as ToolPlanItem } from './desk/types';

const BULK = 200; // upsert 1回あたりの最大行数
const MAX_STEPS = 12;

const normalize = (row: any): DeskNode => ({ ...row, metadata: row.metadata ?? {} });

const clean = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** metadata を既存値にマージする。null / undefined の値はキー削除（＝これまでの「丸ごと上書き」バグの修正） */
function mergeMeta(base: Record<string, any>, patch: Record<string, any>) {
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next;
}

export async function executeDeskPlan(
  executionPlan: ExecutionPlan,
  init: { db: SupabaseClient; nodes: DeskNode[]; idMap: Map<string, string>; command?: string; record?: boolean; signal?: AbortSignal }
) {
  const db = init.db; // ログイン中のユーザーとして動くDBクライアント（RLSが効く）
  let dirty = false;
  // Undo 用：実行前の状態を控えておく（データが変わったときだけ履歴に保存する）
  const before: DeskNode[] = JSON.parse(JSON.stringify(init.nodes));
  const byId = () => new Map(ctx.nodes.map((n) => [n.id, n] as const));

  const ctx: ToolContext = {
    nodes: init.nodes,
    lastTargetIds: [],
    view: null,
    today: new Date(),
    reports: [],
    ui: [],

    realId(id) {
      const mapped = init.idMap.get(id);
      if (mapped) return mapped;
      return ctx.nodes.some((n) => n.id === id) ? id : null;
    },

    async patchNodes(ids, patch: NodePatch) {
      const map = byId();
      const nodes = [...new Set(ids)].map((id) => map.get(id)).filter((n): n is DeskNode => !!n);
      if (!nodes.length) return;

      const { metadata: metaPatch, ...rest } = patch;
      // 本文を書き換えたら、編集した時刻も記録しておく（表示・並べ替えに使う）
      const metadata = patch.content !== undefined ? { ...(metaPatch ?? {}), editedAt: new Date().toISOString() } : metaPatch;
      const columns = clean(rest);

      // metadata を触らないなら1回のUPDATEで済む
      if (!metadata) {
        if (!Object.keys(columns).length) return;
        const { error } = await db
          .from('stark_nodes')
          .update(columns)
          .in(
            'id',
            nodes.map((n) => n.id)
          );
        if (error) throw new Error(`stark_nodes 更新に失敗: ${error.message}`);
        nodes.forEach((n) => Object.assign(n, columns));
        dirty = true;
        return;
      }

      // metadata はノードごとにマージが必要。全行を1回の upsert でまとめて書く（ノード数ぶんの往復を避けて速くする）
      const rows = nodes.map((n) => ({
        id: n.id,
        content: (columns as any).content ?? n.content,
        category: (columns as any).category ?? n.category,
        color: (columns as any).color ?? n.color,
        status: (columns as any).status ?? n.status,
        metadata: mergeMeta(n.metadata, metadata),
        created_at: n.created_at,
      }));
      for (let i = 0; i < rows.length; i += BULK) {
        const { error } = await db.from('stark_nodes').upsert(rows.slice(i, i + BULK), { onConflict: 'id' });
        if (error) throw new Error(`stark_nodes 更新に失敗: ${error.message}`);
      }
      const byRow = new Map(rows.map((r) => [r.id, r] as const));
      nodes.forEach((n) => {
        const r = byRow.get(n.id)!;
        Object.assign(n, columns);
        n.metadata = r.metadata;
      });
      dirty = true;
    },

    async insertNodes(rows: NewNode[]) {
      if (!rows.length) return [];
      const payload = rows.map((r) => ({
        content: r.content,
        category: r.category ?? 'general',
        color: r.color ?? 'cyan',
        status: r.status ?? 'normal',
        metadata: r.metadata ?? {},
      }));
      const { data, error } = await db.from('stark_nodes').insert(payload).select('*');
      if (error) throw new Error(`stark_nodes 追加に失敗: ${error.message}`);
      const created = (data ?? []).map(normalize);
      ctx.nodes.push(...created);
      dirty = true;
      return created;
    },

    async deleteNodes(ids) {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      const { error } = await db.from('stark_nodes').delete().in('id', unique);
      if (error) throw new Error(`stark_nodes 削除に失敗: ${error.message}`);
      const gone = new Set(unique);
      ctx.nodes = ctx.nodes.filter((n) => !gone.has(n.id));
      dirty = true;
    },
  };

  // LLMの配列順ではなく、ツールの phase 順で実行する（同じ phase は元の順序）
  const steps: { item: PlanItem; i: number; tool: ToolDef }[] = [];
  (executionPlan.plan ?? []).slice(0, MAX_STEPS).forEach((item, i) => {
    const tool = getTool(item.tool);
    if (tool) steps.push({ item, i, tool });
  });
  steps.sort((a, b) => a.tool.phase - b.tool.phase || a.i - b.i);

  const logs: string[] = [];
  let failures = 0;

  let aborted = false;
  for (const { item, tool } of steps) {
    // 画面側で「中断」されたら、まだ実行していないステップは行わない
    if (init.signal?.aborted) {
      aborted = true;
      logs.push('⏹ 中断されたため、残りのステップは実行しませんでした');
      break;
    }
    const targets = resolveTargets(ctx, item.target, tool.defaultTarget);
    try {
      logs.push(await tool.run(ctx, targets, item.args));
    } catch (e) {
      failures++;
      logs.push(`⚠ ${tool.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    ctx.lastTargetIds = targets.map((n) => n.id);
  }

  let undoable = false;
  if (dirty && init.record !== false) {
    try {
      await recordOp(db, init.command ?? '(command)', before);
      undoable = true;
    } catch (e) {
      logs.push(`⚠ 履歴(Undo)を保存できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    success: failures === 0,
    message: executionPlan.message,
    logs,
    view: ctx.view, // 整列表示の指令（無ければ null ＝ 今の表示のまま）
    changed: dirty, // true ならクライアントはノードを再取得する
    reports: ctx.reports, // report ツールの回答
    ui: ctx.ui, // 画面側で実行する指令（重ねる・ばらす）
    aborted,
    undoable,
  };
}
