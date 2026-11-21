import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeskNode } from './types';

/*
 * 操作履歴（Undo）。データを変更した指令の「実行前の全ノード」を desk_ops に保存し、
 * 取り消すときはその状態に戻す。AIは使わない（0コスト）。最新 KEEP 件だけ保持する。
 */
const KEEP = 20;

export async function recordOp(db: SupabaseClient, command: string, before: DeskNode[]): Promise<void> {
  const { error } = await db.from('desk_ops').insert({ command: command.slice(0, 200), before });
  if (error) throw new Error(`履歴の保存に失敗: ${error.message}`);

  // 古い履歴を削除（毎回やると往復が増えるので、5回に1回程度）
  if (Math.random() > 0.2) return;
  const { data } = await db.from('desk_ops').select('id').order('created_at', { ascending: false }).range(KEEP, KEEP + 50);
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

export async function undoLastOp(db: SupabaseClient): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await db.from('desk_ops').select('*').order('created_at', { ascending: false }).limit(1);
  if (error) return { ok: false, message: `履歴を読めませんでした: ${error.message}` };
  const op = data?.[0];
  if (!op) return { ok: false, message: '戻せる操作がありません' };

  const snapshot: DeskNode[] = op.before ?? [];
  const keep = new Set(snapshot.map((n) => n.id));

  const { data: current, error: curErr } = await db.from('stark_nodes').select('id');
  if (curErr) return { ok: false, message: `現在の状態を読めませんでした: ${curErr.message}` };
  const extra = (current ?? []).map((r: { id: string }) => r.id).filter((id: string) => !keep.has(id));

  // 先に復元（upsert）してから、増えた分を削除する（途中で失敗してもデータは消えない順序）
  if (snapshot.length) {
    const rows = snapshot.map((n) => ({
      id: n.id,
      content: n.content,
      category: n.category,
      color: n.color,
      status: n.status,
      metadata: n.metadata ?? {},
      created_at: n.created_at,
    }));
    const { error: upErr } = await db.from('stark_nodes').upsert(rows, { onConflict: 'id' });
    if (upErr) return { ok: false, message: `復元に失敗: ${upErr.message}` };
  }
  if (extra.length) {
    const { error: delErr } = await db.from('stark_nodes').delete().in('id', extra);
    if (delErr) return { ok: false, message: `復元後の整理に失敗: ${delErr.message}` };
  }
  await db.from('desk_ops').delete().eq('id', op.id);
  return { ok: true, message: `「${op.command}」を取り消しました` };
}
