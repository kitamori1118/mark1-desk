import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { executeDeskPlan } from '@/lib/deskEngine';
import { compressNodes, createPlan, createWhisper, isReplayable, validateExecutionPlan } from '@/lib/desk/planner';
import { previewOps, recordOp, redoOp, undoOp } from '@/lib/desk/ops';
import { getResolvedModel } from '@/lib/desk/model';
import { related } from '@/lib/desk/similar';
import { localPlan } from '@/lib/desk/localPlan';
import { toDay } from '@/lib/desk/selector';
import type { DeskNode, ExecutionPlan } from '@/lib/desk/types';

/*
 * POST /api/command   （すべてログイン必須。Authorization: Bearer <アクセストークン>）
 *   { command }                       自然文の指令。定型は AI なしの高速パス、それ以外は AI がプランを作る
 *   { action: 'undo' }                直前の操作を取り消す（AIなし）
 *   { action: 'run_macro', id }       保存したマクロを実行（AIなし）
 *   { action: 'save_macro', name, command, plan }   直前のプランをマクロとして保存
 *   { action: 'whisper', nodeId }     新ノードに対する先回り提案（関連ノードがあるときだけAI）
 */

// Vercel の関数実行時間の上限（秒）。AI待ちが長いときに途中で切られないようにする
export const maxDuration = 60;

const MAX_COMMAND_LENGTH = 500;
const MAX_BRAIN_CHARS = 8000;
const UNDO_RE = /^\s*(undo|取り消し(て|ます)?|直前の(操作|指令)を(元に戻|取り消)(して|す)?)\s*[。.!！]*\s*$/i;
const ARCHIVE_WORDS = /アーカイブ|復元|しまった|保管|archive/i;

// 先回り提案のAI呼び出し上限（無料枠を守る簡易ガード。インスタンス単位）
const whisperLog: number[] = [];
const WHISPER_PER_HOUR = 40;

const fail = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });
const unauth = (error = 'ログインが必要です') => NextResponse.json({ success: false, code: 'UNAUTHENTICATED', error }, { status: 401 });

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
    if (!token) return unauth();
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // 認証確認とデータ読み込みは同時に走らせる（待ち時間を重ねない）
    const authP = db.auth.getUser(token);
    const checkAuth = async () => {
      const { data, error } = await authP;
      return error || !data?.user ? unauth('ログインの有効期限が切れました') : null;
    };

    const body = await request.json().catch(() => ({}));
    const action: string = typeof body?.action === 'string' ? body.action : 'command';
    const command = typeof body?.command === 'string' ? body.command.trim() : '';

    /* ---------- 戻す／進む（実行前に、何が起きるかを確認させる） ---------- */
    if (action === 'ops_preview') {
      const bad = await checkAuth();
      if (bad) return bad;
      return NextResponse.json({ success: true, ...(await previewOps(db)) });
    }
    if (action === 'undo' || action === 'redo') {
      const bad = await checkAuth();
      if (bad) return bad;
      if (typeof body.opId !== 'string') return fail(400, '対象の操作が指定されていません');
      const r = action === 'undo' ? await undoOp(db, body.opId) : await redoOp(db, body.opId);
      return NextResponse.json({
        success: r.ok,
        log: r.message,
        error: r.ok ? undefined : r.message,
        refresh: r.ok,
        view: r.ok ? { layout: 'free', order: [], hiddenIds: [] } : null,
      });
    }
    // 画面側で行った手動の編集・削除・追加も、履歴に残す（「戻す」の対象にする）
    if (action === 'log_op') {
      const bad = await checkAuth();
      if (bad) return bad;
      const changed = Array.isArray(body.changed) ? (body.changed as DeskNode[]).slice(0, 300) : [];
      const created = Array.isArray(body.created) ? (body.created as string[]).slice(0, 300) : [];
      if (!changed.length && !created.length) return NextResponse.json({ success: true });
      await recordOp(db, String(body.label ?? '手動の操作'), { changed, created });
      return NextResponse.json({ success: true });
    }
    if (action === 'command' && UNDO_RE.test(command)) {
      return NextResponse.json({ success: true, log: '取り消しは、ヘッダーの「↶ 戻す」「↷ 進む」から行ってください（内容を確認してから実行します）' });
    }

    /* ---------- マクロ保存 ---------- */
    if (action === 'save_macro') {
      const bad = await checkAuth();
      if (bad) return bad;
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
      const bad = await checkAuth();
      if (bad) return bad;
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
        ui: result.ui,
      });
    }

    /* ---------- 先回り提案（関連ノードがあるときだけAI） ---------- */
    if (action === 'whisper') {
      const bad = await checkAuth();
      if (bad) return bad;
      const now = Date.now();
      while (whisperLog.length && now - whisperLog[0] > 3_600_000) whisperLog.shift();
      const nodes = await loadNodes(db);
      const node = nodes.find((n) => n.id === body.nodeId);
      if (!node) return NextResponse.json({ success: true, whispers: [], reason: 'not_found' });
      if (whisperLog.length >= WHISPER_PER_HOUR) return NextResponse.json({ success: true, whispers: [], reason: 'rate_limited' });
      const rel = related(node, nodes);
      if (!rel.length) return NextResponse.json({ success: true, whispers: [], reason: 'no_related' });
      whisperLog.push(now);
      const { compressed } = compressNodes([node, ...rel]);
      const whispers = await createWhisper({
        node: compressed[0],
        related: compressed.slice(1),
        brain: await loadBrain(db),
        today: toDay(new Date()),
      });
      return NextResponse.json({ success: true, whispers, reason: whispers.length ? 'ok' : 'none' });
    }

    /* ---------- 通常の指令 ---------- */
    if (!command) return fail(400, '指令が空です');
    if (command.length > MAX_COMMAND_LENGTH) return fail(400, `指令は${MAX_COMMAND_LENGTH}文字以内にしてください`);

    const tLoad = Date.now();
    const [bad, nodes, brain] = await Promise.all([checkAuth(), loadNodes(db), loadBrain(db)]);
    if (bad) return bad;
    const loadMs = Date.now() - tLoad;

    // ⚡ 高速パス：定型の指令は AI を呼ばずにその場でプランを作る
    const t0 = Date.now();
    let plan: ExecutionPlan | null = localPlan(command, nodes, new Date());
    const local = !!plan;
    let warnings: string[] = [];
    let idMap = new Map<string, string>();
    if (!plan) {
      const { compressed, idMap: map } = compressNodes(nodes, { includeArchived: ARCHIVE_WORDS.test(command) });
      idMap = map;
      const made = await createPlan({ command, brain, nodes: compressed, signal: request.signal });
      plan = made.plan;
      warnings = made.warnings;
    }
    const t1 = Date.now();
    // 画面側で中断されていたら、何も実行しない
    if (request.signal.aborted) return NextResponse.json({ success: false, code: 'ABORTED', error: '中断されました（データは変更していません）' });
    const result = await executeDeskPlan(plan, { db, nodes, idMap, command, signal: request.signal });
    const t2 = Date.now();
    console.log(
      `[JARVIS] "${command}" → ${plan.plan.map((p) => p.tool).join(', ') || '(no steps)'} | ${local ? 'LOCAL' : 'AI'} ${t1 - t0}ms, load ${loadMs}ms, exec ${t2 - t1}ms`
    );

    return NextResponse.json({
      success: result.success,
      log: plan.clarify || plan.unsupported || result.message,
      details: [...result.logs, ...warnings.map((w) => `⚠ ${w}`)],
      view: result.view,
      refresh: result.changed,
      undoable: result.undoable,
      reports: result.reports,
      ui: result.ui,
      aborted: result.aborted,
      clarify: plan.clarify ?? null,
      unsupported: plan.unsupported ?? null,
      timing: { local, planMs: t1 - t0, loadMs, execMs: t2 - t1, model: local ? null : getResolvedModel() },
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
