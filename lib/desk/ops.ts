import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeskNode } from './types';

/*
 * 操作履歴（戻す／進む）。1つの操作が「変えたノードの、変える前の姿」と「新しく作ったノードのID」だけを記録する。
 * 戻すときは、そのノードだけを元に戻す（ほかのノード・その後に追加したノードには一切触れない）。
 * 戻した操作は「進む」で、もう一度やり直せる。新しい操作をすると、「進む」の履歴は消える（一般的な履歴と同じ）。
 *
 * ⚠ 旧バージョンは「実行前の全ノード」を保存し、取り消し時に「保存時点に無いノードは全部削除」していたため、
 *    その後に追加したノードまで消えてしまう不具合があった。旧形式の履歴は危険なので、見つけ次第すべて破棄する。
 */

export interface OpPayload {
  v: 2;
  changed: DeskNode[]; // 変更・削除されたノードの「変更前」の姿
  created: string[]; // この操作で新しく作られたノードのID
  state?: 'applied' | 'undone'; // 省略 = applied
  undoneAt?: string;
  /** 戻した操作を「進む」でやり直すための情報（戻す時点の姿） */
  redo?: { restore: DeskNode[]; remove: string[] };
}

export interface OpPreview {
  id: string;
  command: string;
  createdAt: string;
  ageMin: number;
  changed: number;
  created: number;
}

const KEEP = 100;

const isV2 = (b: unknown): b is OpPayload => !!b && !Array.isArray(b) && (b as OpPayload).v === 2 && Array.isArray((b as OpPayload).changed);
const stateOf = (b: OpPayload) => b.state ?? 'applied';
const toRow = (n: DeskNode) => ({
  id: n.id,
  content: n.content,
  category: n.category,
  color: n.color,
  status: n.status,
  metadata: n.metadata ?? {},
  created_at: n.created_at,
});

type OpRow = { id: string; command: string; before: unknown; created_at: string };

async function recentOps(db: SupabaseClient): Promise<OpRow[]> {
  const { data } = await db.from('desk_ops').select('*').order('created_at', { ascending: false }).limit(60);
  const rows = (data ?? []) as OpRow[];
  // 旧形式（全ノードの保存）の履歴は危険なので破棄する
  const legacy = rows.filter((r) => !isV2(r.before)).map((r) => r.id);
  if (legacy.length) await db.from('desk_ops').delete().in('id', legacy);
  return rows.filter((r) => isV2(r.before));
}

/** 新しい操作を記録する。「進む」の履歴（戻した操作）はここで消える */
export async function recordOp(
  db: SupabaseClient,
  command: string,
  payload: { changed: DeskNode[]; created: string[] }
): Promise<void> {
  const rows = await recentOps(db);
  const undone = rows.filter((r) => stateOf(r.before as OpPayload) === 'undone').map((r) => r.id);
  if (undone.length) await db.from('desk_ops').delete().in('id', undone);

  const body: OpPayload = { v: 2, changed: payload.changed, created: payload.created };
  const { error } = await db.from('desk_ops').insert({ command: command.slice(0, 200), before: body });
  if (error) throw new Error(`履歴の保存に失敗: ${error.message}`);

  // 古い履歴の削除（毎回やると往復が増えるので、5回に1回程度）
  if (Math.random() > 0.2) return;
  const { data } = await db.from('desk_ops').select('id').order('created_at', { ascending: false }).range(KEEP, KEEP + 100);
  if (data?.length) {
    await db
      .from('desk_ops')
      .delete()
      .in(
        'id',
        data.map((r: { id: string }) => r.id)
      );
  }
}

const preview = (op: OpRow): OpPreview => {
  const b = op.before as OpPayload;
  return {
    id: op.id,
    command: op.command ?? '',
    createdAt: op.created_at,
    ageMin: Math.max(0, Math.round((Date.now() - new Date(op.created_at).getTime()) / 60_000)),
    changed: b.changed.length,
    created: b.created.length,
  };
};

/** 「戻す」「進む」を実行したら何が起きるかを、実行前に見せるための情報 */
export async function previewOps(db: SupabaseClient): Promise<{ undo: OpPreview | null; redo: OpPreview | null }> {
  const rows = await recentOps(db);
  const undo = rows.find((r) => stateOf(r.before as OpPayload) === 'applied') ?? null;
  const redo =
    rows
      .filter((r) => stateOf(r.before as OpPayload) === 'undone')
      .sort((a, b) => String((b.before as OpPayload).undoneAt).localeCompare(String((a.before as OpPayload).undoneAt)))[0] ?? null;
  return { undo: undo ? preview(undo) : null, redo: redo ? preview(redo) : null };
}

async function getOp(db: SupabaseClient, id: string): Promise<OpRow | null> {
  const { data } = await db.from('desk_ops').select('*').eq('id', id).limit(1);
  const op = (data?.[0] ?? null) as OpRow | null;
  return op && isV2(op.before) ? op : null;
}

export async function undoOp(db: SupabaseClient, opId: string): Promise<{ ok: boolean; message: string }> {
  const op = await getOp(db, opId);
  if (!op) return { ok: false, message: '戻せる操作がありません' };
  const body = op.before as OpPayload;
  if (stateOf(body) !== 'applied') return { ok: false, message: 'この操作は、すでに戻してあります' };
  const { changed, created } = body;

  // 「進む」で再現できるように、戻す直前の姿（この操作を適用した結果）を控える
  const affected = [...new Set([...changed.map((n) => n.id), ...created])];
  let current: DeskNode[] = [];
  if (affected.length) {
    const { data, error } = await db.from('stark_nodes').select('*').in('id', affected);
    if (error) return { ok: false, message: `現在の状態を読めませんでした: ${error.message}` };
    current = ((data ?? []) as DeskNode[]).map((n) => ({ ...n, metadata: n.metadata ?? {} }));
  }
  const existing = new Set(current.map((n) => n.id));
  const remove = changed.map((n) => n.id).filter((id) => !existing.has(id)); // この操作が削除したノード → 「進む」で再び削除

  // 先に復元（upsert）してから、この操作で作られたノードだけを削除する（途中で失敗してもデータは消えない順序）
  if (changed.length) {
    const { error } = await db.from('stark_nodes').upsert(changed.map(toRow), { onConflict: 'id' });
    if (error) return { ok: false, message: `復元に失敗: ${error.message}` };
  }
  if (created.length) {
    const { error } = await db.from('stark_nodes').delete().in('id', created);
    if (error) return { ok: false, message: `追加の取り消しに失敗: ${error.message}` };
  }
  const next: OpPayload = { ...body, state: 'undone', undoneAt: new Date().toISOString(), redo: { restore: current, remove } };
  await db.from('desk_ops').update({ before: next }).eq('id', op.id);
  return { ok: true, message: `「${op.command}」を取り消しました（元に戻した${changed.length}件・取り消した追加${created.length}件）。「↷ 進む」でやり直せます` };
}

export async function redoOp(db: SupabaseClient, opId: string): Promise<{ ok: boolean; message: string }> {
  const op = await getOp(db, opId);
  if (!op) return { ok: false, message: 'やり直せる操作がありません' };
  const body = op.before as OpPayload;
  if (stateOf(body) !== 'undone' || !body.redo) return { ok: false, message: 'この操作は、やり直せる状態ではありません' };
  const { restore, remove } = body.redo;

  if (restore.length) {
    const { error } = await db.from('stark_nodes').upsert(restore.map(toRow), { onConflict: 'id' });
    if (error) return { ok: false, message: `やり直しに失敗: ${error.message}` };
  }
  if (remove.length) {
    const { error } = await db.from('stark_nodes').delete().in('id', remove);
    if (error) return { ok: false, message: `やり直しに失敗: ${error.message}` };
  }
  const { redo: _r, undoneAt: _u, ...rest } = body;
  await db.from('desk_ops').update({ before: { ...rest, state: 'applied' } }).eq('id', op.id);
  return { ok: true, message: `「${op.command}」をやり直しました（再適用 ${restore.length}件・削除 ${remove.length}件）` };
}
