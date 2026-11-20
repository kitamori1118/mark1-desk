import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { executeDeskPlan } from '@/lib/deskEngine';
import { compressNodes, createPlan, createWhisper, isReplayable, validateExecutionPlan } from '@/lib/desk/planner';
import { undoLastOp } from '@/lib/desk/ops';
import { findSimilar } from '@/lib/desk/similar';
import type { DeskNode } from '@/lib/desk/types';

/*
 * POST /api/command
 *   { command }                       自然文の指令（AIがプランを作る）
 *   { action: 'undo' }                直前の操作を取り消す（AIなし）
 *   { action: 'run_macro', id }       保存したマクロを実行（AIなし）
 *   { action: 'save_macro', name, command, plan }   直前のプランをマクロとして保存
 *   { action: 'whisper', nodeId }     新ノードに対する先回り提案（類似ノードがあるときだけAI）
 */

const MAX_COMMAND_LENGTH = 500;
const MAX_BRAIN_CHARS = 8000;
const UNDO_RE = /^\s*(undo|取り消し(て|ます)?|直前の(操作|指令)を(元に戻|取り消)(して|す)?)\s*[。.!！]*\s*$/i;
const ARCHIVE_WORDS = /アーカイブ|復元|しまった|保管|archive/i;

// 先回り提案の呼び出し上限（無料枠を守る簡易ガード。インスタンス単位）
const whisperLog: number[] = [];
const WHISPER_PER_HOUR = 30;

const fail = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

async function loadNodes(db: SupabaseClient): Promise<DeskNode[]> {
  const { data, error } = await db.from('stark_nodes').select('*').order('created_at', { ascending: true });
  if (error) throw new Error(`stark_nodes 取得に失敗: ${error.message}`);
  return (data ?? []).map((n: any) => ({ ...n, metadata: n.metadata ?? {} }));
}

async function loadBrain(db: SupabaseClient): Promise<string> {
  const { data } = await db.from('brain_context').select('title, content').order('updated_at', { ascending: true });
  return data?.length
    ? data
        .map((m: { title?: string; content: string }) => `[${m.title || 'Note'}]\n${m.content}`)
        .join('\n---\n')
        .slice(0, MAX_BRAIN_CHARS)
    : 'No custom context provided.';
}

export async function POST(request: Request) {
  try {
    // 🔐 ログイン必須：ブラウザが送ってくるアクセストークンで、そのユーザーとして DB にアクセスする（RLSが効く）
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return NextResponse.json({ success: false, code: 'UNAUTHENTICATED', error: 'ログインが必要です' }, { status: 401 });
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: who, error: whoErr } = await db.auth.getUser(token);
    if (whoErr || !who?.user) {
      return NextResponse.json({ success: false, code: 'UNAUTHENTICATED', error: 'ログインの有効期限が切れました' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const action: string = typeof body?.action === 'string' ? body.action : 'command';
    const command = typeof body?.command === 'string' ? body.command.trim() : '';

    /* ---------- Undo ---------- */
    if (action === 'undo' || (action === 'command' && UNDO_RE.test(command))) {
      const r = await undoLastOp(db);
      return NextResponse.json({
        success: r.ok,
        log: r.message,
        error: r.ok ? undefined : r.message,
        refresh: r.ok,
        view: r.ok ? { layout: 'free', order: [], hiddenIds: [] } : null,
      });
    }

    /* ---------- マクロ保存 ---------- */
    if (action === 'save_macro') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
      if (!name) return fail(400, 'マクロ名が空です');
      const { plan, errors } = validateExecutionPlan(body.plan);
      if (errors.length) return fail(400, `プランが不正です: ${errors[0]}`);
      if (!isReplayable(plan)) {
        return fail(400, '個別のノードIDやAIが書いた文面を含む指令は、マクロにできません（条件だけの指令が保存できます）');
      }
      const { error } = await db
        .from('desk_macros')
        .upsert({ name, command: String(body.command ?? '').slice(0, 300), plan }, { onConflict: 'name' });
      if (error) throw new Error(`マクロ保存に失敗: ${error.message}`);
      return NextResponse.json({ success: true, log: `マクロ「${name}」を保存しました` });
    }

    /* ---------- マクロ実行（AIを呼ばない） ---------- */
    if (action === 'run_macro') {
      const { data, error } = await db.from('desk_macros').select('*').eq('id', body.id).single();
      if (error || !data) return fail(404, 'マクロが見つかりません');
      const { plan, errors } = validateExecutionPlan(data.plan);
      if (errors.length) return fail(400, `保存されたプランが不正です: ${errors[0]}`);
      const nodes = await loadNodes(db);
      const result = await executeDeskPlan(plan, { db, nodes, idMap: new Map(), command: `マクロ: ${data.name}` });
      return NextResponse.json({
        success: result.success,
        log: `マクロ「${data.name}」: ${result.logs.join(' / ') || '実行しました'}`,
        details: result.logs,
        view: result.view,
        refresh: result.changed,
        undoable: result.undoable,
        reports: result.reports,
      });
    }

    /* ---------- 先回り提案 ---------- */
    if (action === 'whisper') {
      const now = Date.now();
      while (whisperLog.length && now - whisperLog[0] > 3_600_000) whisperLog.shift();
      const nodes = await loadNodes(db);
      const node = nodes.find((n) => n.id === body.nodeId);
      if (!node) return NextResponse.json({ success: true, whisper: null });
      const similar = findSimilar(node, nodes); // 似たノードが無ければAIを呼ばない
      if (!similar.length || whisperLog.length >= WHISPER_PER_HOUR) return NextResponse.json({ success: true, whisper: null });
      whisperLog.push(now);
      const { compressed } = compressNodes([node, ...similar]);
      const whisper = await createWhisper({ node: compressed[0], candidates: compressed.slice(1), brain: await loadBrain(db) });
      return NextResponse.json({ success: true, whisper });
    }

    /* ---------- 通常の指令 ---------- */
    if (!command) return fail(400, '指令が空です');
    if (command.length > MAX_COMMAND_LENGTH) return fail(400, `指令は${MAX_COMMAND_LENGTH}文字以内にしてください`);

    const [nodes, brain] = await Promise.all([loadNodes(db), loadBrain(db)]);
    const { compressed, idMap } = compressNodes(nodes, { includeArchived: ARCHIVE_WORDS.test(command) });
    const { plan, warnings } = await createPlan({ command, brain, nodes: compressed });
    const result = await executeDeskPlan(plan, { db, nodes, idMap, command });

    return NextResponse.json({
      success: result.success,
      log: plan.clarify || plan.unsupported || result.message,
      details: [...result.logs, ...warnings.map((w) => `⚠ ${w}`)],
      view: result.view,
      refresh: result.changed,
      undoable: result.undoable,
      reports: result.reports,
      clarify: plan.clarify ?? null,
      unsupported: plan.unsupported ?? null,
      // マクロ保存ボタン用：条件だけで再実行できるプランのときだけ返す
      savablePlan: isReplayable(plan) ? plan : null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    const limited = /429|RESOURCE_EXHAUSTED/.test(message);
    return NextResponse.json(
      {
        success: false,
        code: limited ? 'RATE_LIMITED' : 'ERROR',
        error: limited ? '通信が混み合っています。少し待ってからもう一度お試しください' : message,
      },
      { status: limited ? 429 : 500 }
    );
  }
}
