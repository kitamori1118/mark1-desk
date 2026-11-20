'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ViewDirective, ViewLayout } from '@/lib/desk/types';
import { computeViewPositions } from '@/lib/desk/layoutPositions';
import { daysUntil } from '@/lib/desk/selector';

interface StarkNode {
  id: string;
  content: string;
  category: string;
  color: 'cyan' | 'amber' | 'crimson' | 'emerald';
  status: string;
  metadata?: {
    tags?: string[];
    opacity?: number;
    commentMode?: boolean;
    comment?: string; // diagnostic_scan / deadline_alert のコメント
    due?: string; // YYYY-MM-DD
    stage?: string; // 未着手 / 進行中 / 完了 など
    pinned?: boolean;
    archived?: boolean;
    links?: string[]; // 線でつないだ相手
    sources?: string[]; // コア・AI生成ノードの元ノード
    ai?: boolean;
  };
  created_at: string;
}

interface DeskTag {
  id: string;
  tag_name: string;
}

interface Macro {
  id: string;
  name: string;
}

type Pos = { x: number; y: number };

/** 整列表示中のオーブの大きさ（スマホ幅でも2列に収まるよう少しコンパクトにする） */
const VIEW_ORB = 148;
const VIEW_GAP = 16;

const VIEW_LABEL: Record<ViewLayout, string> = {
  free: 'FREE',
  list: 'LIST',
  grid: 'GRID',
  columns: 'GROUPS',
  kanban: 'KANBAN',
  matrix: 'MATRIX',
  timeline: 'TIMELINE',
  orbit: 'ORBIT',
};

/** 通常時のオーブの大きさ（スマホ176 / PC192） */
const freeOrbSize = () => (typeof window !== 'undefined' && window.innerWidth >= 768 ? 192 : 176);

const WHISPER_KEY = 'mark1desk.whisper';
/** サーバー側の上限（60秒）より少し長く待ち、それでも返らなければ画面側で打ち切る */
const CLIENT_TIMEOUT_MS = 70_000;

export default function Mark1DeskPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false); // ログイン確認が済むまで画面を出さない
  const [nodes, setNodes] = useState<StarkNode[]>([]);
  const [quickSlots, setQuickSlots] = useState<string[]>([]);
  const [command, setCommand] = useState('');

  const [isInputOpen, setIsInputOpen] = useState(false);
  const [rawInputContent, setRawInputContent] = useState('');

  const [systemLog, setSystemLog] = useState('MARK1-DESK // NEURAL ORB MATRIX ONLINE.');
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('');
  const [elapsed, setElapsed] = useState(0); // 実行中の経過秒数（止まっているのか待っているのか分かるように）
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [nodePositions, setNodePositions] = useState<Record<string, Pos>>({});

  // 💡 AIの「整列表示」指令。null = 自由配置
  const [view, setView] = useState<ViewDirective | null>(null);
  const [viewLayout, setViewLayout] = useState<{
    labels: { key: string; label: string; x: number; y: number; w?: number }[];
    size: { width: number; height: number };
  } | null>(null);
  const savedFree = useRef<Record<string, Pos> | null>(null); // 整列前の自由配置
  const mainRef = useRef<HTMLElement | null>(null);

  // 💡 アーカイブ / 回答パネル / マクロ / 先回り提案
  const [showArchived, setShowArchived] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [macroOpen, setMacroOpen] = useState(false);
  const [lastRun, setLastRun] = useState<{ command: string; plan: unknown } | null>(null);
  const [whisperOn, setWhisperOn] = useState(false);
  const [whisper, setWhisper] = useState<{ message: string; command: string | null } | null>(null);

  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    try {
      setWhisperOn(localStorage.getItem(WHISPER_KEY) === '1');
    } catch {
      /* 保存できない環境では既定のOFFのまま */
    }
  }, []);
  useEffect(() => {
    if (!loading) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [loading]);

  const toggleWhisper = () => {
    setWhisperOn((v) => {
      try {
        localStorage.setItem(WHISPER_KEY, v ? '0' : '1');
      } catch {
        /* noop */
      }
      return !v;
    });
    setWhisper(null);
  };

  const orb = view ? VIEW_ORB : isDesktop ? 192 : 176;
  const compact = !!view;
  const hiddenSet = useMemo(() => new Set(view?.hiddenIds ?? []), [view]);
  const archivedCount = useMemo(() => nodes.filter((n) => n.metadata?.archived).length, [nodes]);
  const visibleNodes = useMemo(() => (showArchived ? nodes : nodes.filter((n) => !n.metadata?.archived)), [nodes, showArchived]);

  // 💡 線：link_nodes の線（実線）と、コア・AI生成ノードの元ノードへの線（点線）
  const edges = useMemo(() => {
    const ids = new Set(visibleNodes.map((n) => n.id));
    const seen = new Set<string>();
    const out: { a: string; b: string; kind: 'link' | 'source' }[] = [];
    for (const n of visibleNodes) {
      const add = (other: string, kind: 'link' | 'source') => {
        if (!ids.has(other) || other === n.id) return;
        const key = [n.id, other].sort().join('|');
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ a: n.id, b: other, kind });
      };
      (n.metadata?.links ?? []).forEach((o) => add(o, 'link'));
      (n.metadata?.sources ?? []).forEach((o) => add(o, 'source'));
    }
    return out;
  }, [visibleNodes]);

  // 💡 整列ロジック（確実に円形・放射状に再配置する）
  const relayoutNodes = (nodeList: StarkNode[]) => {
    const nextPos: Record<string, Pos> = {};
    const half = freeOrbSize() / 2;
    const centerX = (typeof window !== 'undefined' ? window.innerWidth : 800) / 2 - half;
    const centerY = (typeof window !== 'undefined' ? window.innerHeight : 600) / 2 - half;
    const radius = Math.min(centerX, centerY) * 0.55;

    nodeList.forEach((node, index) => {
      const angle = (index / nodeList.length) * Math.PI * 2;
      nextPos[node.id] = {
        x: Math.max(20, centerX + Math.cos(angle) * (radius || 150)),
        y: Math.max(80, centerY + Math.sin(angle) * (radius || 150)),
      };
    });
    setNodePositions(nextPos);
  };

  /** 整列表示を解除する。restore=true なら整列前の自由配置に戻す */
  const clearView = (restore: boolean) => {
    setView(null);
    setViewLayout(null);
    const saved = savedFree.current;
    savedFree.current = null;
    if (restore && saved) {
      setNodePositions((prev) => {
        const merged = { ...prev };
        Object.keys(saved).forEach((id) => {
          if (id in prev) merged[id] = saved[id];
        });
        return merged;
      });
    }
    mainRef.current?.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  };

  /** AIの整列指令を画面に反映する（座標計算は lib/desk/layoutPositions.ts） */
  const applyView = (v: ViewDirective) => {
    const width = mainRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 390);
    const layout = computeViewPositions(v, { width, orb: VIEW_ORB, gap: VIEW_GAP });
    if (!layout) {
      clearView(true);
      return;
    }
    const half = VIEW_ORB / 2;
    setNodePositions((prev) => {
      if (!savedFree.current) savedFree.current = prev; // 最初の整列のときだけ元の配置を保存
      const next = { ...prev };
      Object.entries(layout.positions).forEach(([id, p]) => {
        next[id] = { x: p.x - half, y: p.y - half };
      });
      return next;
    });
    setView(v);
    setViewLayout({ labels: layout.labels, size: layout.size });

    requestAnimationFrame(() => {
      const el = mainRef.current;
      if (!el) return;
      el.scrollTo({
        left: v.layout === 'orbit' ? Math.max(0, (layout.size.width - el.clientWidth) / 2) : 0,
        top: v.layout === 'orbit' ? Math.max(0, (layout.size.height - el.clientHeight) / 2) : 0,
        behavior: 'smooth',
      });
    });
  };

  const fetchMacros = async () => {
    const { data, error } = await supabase.from('desk_macros').select('id, name').order('created_at', { ascending: true });
    if (!error && data) setMacros(data as Macro[]);
  };

  const fetchNodes = async (forceRelayout = false) => {
    const { data: nodeData } = await supabase.from('stark_nodes').select('*').order('created_at', { ascending: false });
    if (nodeData) {
      setNodes(nodeData);
      if (forceRelayout || Object.keys(nodePositions).length === 0) {
        relayoutNodes(nodeData.filter((n: StarkNode) => !n.metadata?.archived));
      }
      // 位置を持たないノード（新規・アーカイブ表示用）は、ずらして配置を補完
      setNodePositions((prev) => {
        const updated = { ...prev };
        nodeData.forEach((n: StarkNode, i: number) => {
          if (!updated[n.id]) updated[n.id] = { x: 100 + ((i * 40) % 500), y: 150 + ((i * 30) % 400) };
        });
        return updated;
      });
    }

    const { data: tagData } = await supabase.from('desk_tags').select('*');
    if (tagData) {
      setQuickSlots(tagData.map((t: DeskTag) => '@' + t.tag_name));
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace('/login');
        return;
      }
      setAuthed(true);
      fetchNodes(true);
      fetchMacros();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') router.replace('/login');
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  /* ---------------- API 呼び出し ---------------- */

  const post = async (body: Record<string, unknown>, track = true) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      router.replace('/login');
      return null;
    }
    const ctrl = new AbortController();
    if (track) {
      abortRef.current = ctrl;
      cancelledRef.current = false;
    }
    const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        // JSONではない＝Next.js自体のエラーページ。ルートが見つからない／ビルドエラー／時間切れの可能性
        setSystemLog(`ERROR: HTTP ${res.status} /api/command（ルートの配置・ビルド・実行時間の上限を確認）`);
        return null;
      }
      if (res.status === 401) router.replace('/login');
      if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
      return json;
    } catch (err) {
      if (track && cancelledRef.current) {
        setSystemLog('CANCELLED: 中断しました（サーバー側の処理は続いていることがあります。「↶ 戻す」で確認できます）');
      } else if ((err as { name?: string })?.name === 'AbortError') {
        setSystemLog(`ERROR: ${CLIENT_TIMEOUT_MS / 1000}秒たっても応答がありません（AIの混雑、またはサーバーが止まっている可能性）`);
      } else {
        setSystemLog('ERROR: 通信に失敗しました（ネットワークを確認）');
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /** サーバーの返答を画面に反映する（指令・Undo・マクロ共通） */
  const handleResponse = async (data: any, opts: { command?: string; fromInput?: boolean } = {}) => {
    if (!data) return;
    if (data.error) {
      setSystemLog(`ERROR: ${data.error}`);
      return;
    }
    const warnings: string[] = (data.details ?? []).filter((d: string) => d.startsWith('⚠'));
    if (warnings.length) console.warn('[JARVIS]', warnings);

    const prefix = data.clarify ? '❓ ' : data.unsupported ? '⚠ 未対応: ' : '';
    // 通常の指令では、各ツールが実際に何をしたか（件数など）も出す。マクロ・Undoは log に含まれている
    const done =
      opts.command !== undefined && !data.clarify && !data.unsupported
        ? (data.details ?? []).filter((d: string) => !d.startsWith('⚠')).join(' / ')
        : '';
    const timing = data.timing
      ? ` ⏱AI ${(data.timing.planMs / 1000).toFixed(1)}秒${data.timing.model ? `・${data.timing.model}` : ''}`
      : '';
    setSystemLog(
      prefix +
        (data.log || 'COMMAND EXECUTED.') +
        (done ? ` — ${done}` : '') +
        (warnings.length ? ` (警告${warnings.length}件)` : '') +
        timing
    );

    // 聞き返し・未対応のときは指令を残して、言い直せるようにする
    if (opts.fromInput && !data.clarify && !data.unsupported) setCommand('');
    if (opts.command !== undefined) setLastRun(data.savablePlan ? { command: opts.command, plan: data.savablePlan } : null);

    if (data.reports?.length) setReport(data.reports.join('\n\n'));
    if (data.refresh) await fetchNodes();
    if (data.view) {
      if (data.view.layout === 'free') clearView(true);
      else applyView(data.view as ViewDirective);
    }
  };

  /** 実行系の共通処理。どこで失敗しても、必ず「実行中」を解除して画面が固まらないようにする */
  const withLoading = async (label: string, job: () => Promise<void>) => {
    if (loading) return;
    setLoading(true);
    setLoadingLabel(label);
    try {
      await job();
    } catch (e) {
      setSystemLog(`ERROR: ${e instanceof Error ? e.message : '画面の更新に失敗しました'}`);
    } finally {
      setLoading(false);
    }
  };

  const runCommand = async (text: string, fromInput = false) => {
    if (!text.trim()) return;
    await withLoading(`「${text}」を実行中`, async () => {
      const data = await post({ command: text });
      await handleResponse(data, { command: text, fromInput });
    });
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runCommand(command, true);
  };

  const handleUndo = () =>
    withLoading('取り消し中', async () => {
      await handleResponse(await post({ action: 'undo' }));
    });

  const runMacro = (m: Macro) =>
    withLoading(`マクロ「${m.name}」を実行中`, async () => {
      await handleResponse(await post({ action: 'run_macro', id: m.id }));
    });

  const cancelRunning = () => {
    cancelledRef.current = true;
    abortRef.current?.abort();
  };

  const saveMacro = async () => {
    if (!lastRun) return;
    const name = window.prompt('マクロ名（例: 朝の整理）', lastRun.command.slice(0, 20));
    if (!name?.trim()) return;
    const data = await post({ action: 'save_macro', name: name.trim(), command: lastRun.command, plan: lastRun.plan });
    if (data?.error) setSystemLog(`ERROR: ${data.error}`);
    else {
      setSystemLog(data?.log || 'MACRO SAVED.');
      setLastRun(null);
      fetchMacros();
    }
  };

  const deleteMacro = async (m: Macro) => {
    if (!window.confirm(`マクロ「${m.name}」を削除しますか？`)) return;
    await supabase.from('desk_macros').delete().eq('id', m.id);
    fetchMacros();
  };

  /* ---------------- ノードの追加・削除・ドラッグ ---------------- */

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawInputContent.trim()) return;

    let text = rawInputContent;
    const tagMatches = text.match(/@([^\s@]+)/g) || [];
    const extractedTags = tagMatches.map((t) => t.replace('@', ''));

    tagMatches.forEach((tag) => {
      text = text.replace(tag, '');
    });
    text = text.trim();

    const primaryCategory = extractedTags[0] || '一般';
    const allTags = extractedTags.length > 0 ? extractedTags : ['一般'];

    setSystemLog(`SYNTHESIZING ORB...`);

    const { data: created, error } = await supabase
      .from('stark_nodes')
      .insert({
        content: text || rawInputContent.trim(),
        category: primaryCategory,
        color: allTags.includes('アイデア') ? 'amber' : allTags.includes('課題') ? 'crimson' : 'cyan',
        status: 'normal',
        metadata: { tags: allTags, opacity: 1, commentMode: false },
      })
      .select('id')
      .single();

    if (!error) {
      setRawInputContent('');
      setIsInputOpen(false);
      clearView(false); // 新規投入後は円形の自動整列に戻る
      await fetchNodes(true);
      setSystemLog('ORB MATRIX EXPANDED.');

      // 🛰 先回り提案：似たノードがあるときだけ、サーバー側でAIを呼ぶ
      if (whisperOn && created?.id) {
        post({ action: 'whisper', nodeId: created.id }, false).then((d) => {
          if (d?.whisper?.message) setWhisper(d.whisper);
        });
      }
    } else {
      setSystemLog(`ERROR: ${error.message}`);
    }
  };

  const appendSlotTag = (tag: string) => {
    setRawInputContent((prev) => {
      if (prev.includes(tag)) return prev;
      return prev ? `${tag} ${prev}` : `${tag} `;
    });
  };

  const handleDeleteNode = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // .select() で「実際に消えた行」を受け取る。RLSに DELETE ポリシーが無いと、エラーなしで0件になる
    const { data, error } = await supabase.from('stark_nodes').delete().eq('id', id).select('id');
    if (error) {
      setSystemLog(`ERROR: 削除に失敗: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) {
      setSystemLog('ERROR: 削除できませんでした（Supabase の RLS に DELETE の許可が無い可能性）');
      return;
    }
    setNodePositions((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    await fetchNodes();
    setSystemLog('ORB EXPUNGED.');
  };

  const startDrag = (id: string, clientX: number, clientY: number) => {
    setDraggingId(id);
    const currentPos = nodePositions[id] || { x: 20, y: 20 };
    setDragOffset({ x: clientX - currentPos.x, y: clientY - currentPos.y });
  };

  const moveDrag = (clientX: number, clientY: number) => {
    if (!draggingId) return;
    setNodePositions((prev) => ({
      ...prev,
      [draggingId]: {
        x: clientX - dragOffset.x,
        y: clientY - dragOffset.y,
      },
    }));
  };

  const endDrag = () => setDraggingId(null);

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#030712] text-[#00f0ff] font-mono flex items-center justify-center text-xs tracking-widest">
        AUTHENTICATING...
      </div>
    );
  }

  const half = orb / 2;
  const headerBtn =
    'border border-[#00f0ff]/40 bg-[#0a1128] px-2.5 py-1 rounded text-[10px] text-[#00f0ff] hover:bg-[#00f0ff]/20 transition-all disabled:opacity-40';

  return (
    <div
      className="min-h-screen bg-[#030712] text-[#00f0ff] font-mono overflow-hidden relative select-none flex flex-col justify-between"
      onMouseMove={(e) => moveDrag(e.clientX, e.clientY)}
      onMouseUp={endDrag}
      onTouchMove={(e) => {
        if (e.touches[0]) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
      }}
      onTouchEnd={endDrag}
    >
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#00f0ff05_1px,transparent_1px),linear-gradient(to_bottom,#00f0ff05_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,#030712_95%)] pointer-events-none" />

      {/* 💡 線：「つないで」で作った線（実線）と、コア・AI生成ノードの元ノードへの線（点線）だけ描く。指令が無いときは線なし */}
      {!view && edges.length > 0 && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
          {edges.map((e) => {
            const p1 = nodePositions[e.a];
            const p2 = nodePositions[e.b];
            if (!p1 || !p2) return null;
            return (
              <line
                key={`edge-${e.a}-${e.b}`}
                x1={p1.x + half}
                y1={p1.y + half}
                x2={p2.x + half}
                y2={p2.y + half}
                stroke={e.kind === 'link' ? '#00f0ff' : '#fbbf24'}
                strokeWidth={e.kind === 'link' ? 1.5 : 1}
                strokeOpacity={e.kind === 'link' ? 0.55 : 0.4}
                strokeDasharray={e.kind === 'link' ? undefined : '4 4'}
              />
            );
          })}
        </svg>
      )}

      <header className="relative z-30 flex justify-between items-center gap-2 px-4 py-3 bg-[#030712]/80 backdrop-blur-md border-b border-[#00f0ff33]">
        <div className="min-w-0">
          <h1 className="text-xs md:text-sm font-bold tracking-widest text-[#00f0ff] drop-shadow-[0_0_8px_rgba(0,240,255,0.6)] truncate">
            MARK1-DESK // NEURAL ORB MATRIX
          </h1>
          <p className="text-[9px] text-slate-400">FLUID ORB & COMMENT SCANNER ACTIVE</p>
        </div>
        <div className="flex flex-wrap justify-end items-center gap-1.5">
          <button onClick={handleUndo} disabled={loading} className={headerBtn} title="直前の操作を取り消す">
            ↶ 戻す
          </button>
          {archivedCount > 0 && (
            <button onClick={() => setShowArchived((v) => !v)} className={headerBtn} title="アーカイブ済みの表示切り替え">
              🗄 {archivedCount}
              {showArchived ? ' ✓' : ''}
            </button>
          )}
          <button
            onClick={() => {
              clearView(false);
              fetchNodes(true);
            }}
            className={`${headerBtn} shadow-[0_0_8px_rgba(0,240,255,0.3)]`}
          >
            ⊞ 自動整列
          </button>
          <Link href="/settings" className={headerBtn}>
            ⚙️ VAULT & TAGS
          </Link>
          <button onClick={handleLogout} className={headerBtn} title="ログアウト">
            ⏻
          </button>
        </div>
      </header>

      {/* 整列表示中のステータスバー */}
      {view && (
        <div className="relative z-20 flex items-center justify-between gap-2 px-4 py-1.5 text-[10px] bg-[#0a1128]/80 border-b border-[#00f0ff]/20">
          <span className="truncate tracking-widest text-[#00f0ff]">
            VIEW // {VIEW_LABEL[view.layout]}
            {view.title ? ` — ${view.title}` : ''} <span className="text-slate-400">({view.order.length})</span>
          </span>
          <button
            type="button"
            onClick={() => clearView(true)}
            className="shrink-0 border border-[#00f0ff]/40 bg-[#030712] px-2 py-0.5 rounded text-[10px] text-[#00f0ff] hover:bg-[#00f0ff]/20 active:scale-95 transition-all"
          >
            ✕ 整列を解除
          </button>
        </div>
      )}

      {/* メイン オーブ空間 */}
      <main ref={mainRef} className="relative z-10 flex-1 w-full h-[calc(100vh-170px)] overflow-auto">
        {/* 整列表示のとき、スクロール範囲を確保する（下部の固定フッター分も加算） */}
        {viewLayout && (
          <div
            className="absolute top-0 left-0 pointer-events-none"
            style={{ width: viewLayout.size.width, height: viewLayout.size.height + 180 }}
          />
        )}

        {/* セクション見出し（グループ・時系列・カンバン・マトリクス） */}
        {viewLayout?.labels.map((l) => (
          <div
            key={l.key}
            style={{ transform: `translate(${l.x}px, ${l.y}px)`, width: l.w }}
            className={`absolute top-0 left-0 z-0 text-[11px] tracking-widest text-[#00f0ff]/80 border-b border-[#00f0ff]/30 pb-0.5 pointer-events-none ${
              l.w ? 'truncate' : 'whitespace-nowrap'
            }`}
          >
            {l.label}
          </div>
        ))}

        {visibleNodes.map((node) => {
          const pos = nodePositions[node.id] || { x: 100, y: 100 };
          const isScanned = node.status === 'scanned';
          const isHighlight = node.status === 'highlight';
          const isHidden = hiddenSet.has(node.id) && !node.metadata?.archived;
          const isArchived = !!node.metadata?.archived;
          const commentMode = node.metadata?.commentMode;
          const comment = node.metadata?.comment;
          const opacity = isArchived ? 0.4 : node.metadata?.opacity ?? 1;
          const tags = node.metadata?.tags && node.metadata.tags.length > 0 ? node.metadata.tags : [node.category];

          // 期限バッジ（AIを使わず、画面側で常に計算する）
          const due = node.metadata?.due;
          const left = due ? daysUntil(due, new Date()) : NaN;
          const done = node.metadata?.stage === '完了';
          const dueClass =
            Number.isNaN(left) || done
              ? 'text-slate-400'
              : left < 0
              ? 'text-rose-300 border-rose-400'
              : left <= 3
              ? 'text-amber-300 border-amber-400'
              : 'text-slate-300';

          const orbColor =
            node.color === 'amber'
              ? 'border-amber-400/80 text-amber-300 shadow-[0_0_25px_rgba(251,191,36,0.35)] bg-gradient-to-br from-[#1a1500]/90 to-[#0a1128]/95'
              : node.color === 'crimson'
              ? 'border-rose-500 text-rose-300 shadow-[0_0_30px_rgba(244,63,94,0.5)] animate-pulse bg-gradient-to-br from-[#200008]/95 to-[#0a1128]/95'
              : node.color === 'emerald'
              ? 'border-emerald-400/80 text-emerald-300 shadow-[0_0_25px_rgba(52,211,153,0.35)] bg-gradient-to-br from-[#002010]/90 to-[#0a1128]/95'
              : 'border-[#00f0ff]/80 text-[#00f0ff] shadow-[0_0_25px_rgba(0,240,255,0.35)] bg-gradient-to-br from-[#001525]/90 to-[#0a1128]/95';

          return (
            <div
              key={node.id}
              onMouseDown={(e) => startDrag(node.id, e.clientX, e.clientY)}
              onTouchStart={(e) => {
                if (e.touches[0]) startDrag(node.id, e.touches[0].clientX, e.touches[0].clientY);
              }}
              style={{
                width: orb,
                height: orb,
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                opacity: isHidden ? 0 : opacity,
                pointerEvents: isHidden ? 'none' : undefined,
              }}
              // 💡 まん丸ではなく「四角めで角が丸い」形（rounded-[28px]）。移動はドラッグ中だけアニメ無し
              className={`absolute top-0 left-0 cursor-grab active:cursor-grabbing rounded-[28px] backdrop-blur-2xl border flex flex-col items-center justify-center p-3 text-center ${
                draggingId === node.id ? '' : 'transition-[transform,opacity,box-shadow] duration-500 ease-out motion-reduce:transition-none'
              } ${orbColor} ${isArchived ? 'border-dashed' : ''} ${
                draggingId === node.id
                  ? 'z-40 scale-110 shadow-[0_0_40px_rgba(0,240,255,0.7)]'
                  : isHighlight
                  ? 'scale-105 ring-2 ring-[#00f0ff] z-20'
                  : isScanned
                  ? 'ring-1 ring-amber-300/60 z-10'
                  : 'z-10'
              }`}
            >
              {node.metadata?.pinned && <span className="absolute top-1.5 left-3 text-[10px]">📌</span>}

              {/* タグ表示 */}
              <div className="flex flex-wrap justify-center gap-1 mb-1 max-w-full overflow-hidden max-h-[38px]">
                {tags.map((t, idx) => (
                  <span key={idx} className="text-[8px] px-1.5 py-0.5 rounded-full bg-black/60 border border-current tracking-wider font-bold">
                    @{t}
                  </span>
                ))}
              </div>

              {/* 本文（角丸の四角なので、まん丸のときより行数を多く出せる） */}
              <p
                className={`text-[11px] md:text-xs tracking-wide text-slate-100 leading-tight px-1 ${
                  compact ? 'line-clamp-3' : 'line-clamp-4'
                }`}
              >
                {node.content}
              </p>

              {/* 期限・ステージ・AI生成の印 */}
              {(due || node.metadata?.stage || node.metadata?.ai) && (
                <div className="mt-1 flex flex-wrap justify-center gap-1 text-[8px]">
                  {node.metadata?.ai && <span className="px-1 rounded border border-current text-fuchsia-300">AI</span>}
                  {node.metadata?.stage && (
                    <span className="px-1 rounded border border-current text-slate-300">{node.metadata.stage}</span>
                  )}
                  {due && <span className={`px-1 rounded border ${dueClass}`}>📅 {due.slice(5).replace('-', '/')}</span>}
                </div>
              )}

              {/* コメントモード（スキャン・期限アラートの解説オーバーレイ） */}
              {commentMode && (
                <div className="absolute -bottom-3 max-w-[92%] truncate bg-cyan-950/90 border border-[#00f0ff] text-[#00f0ff] text-[8px] px-2 py-0.5 rounded-full shadow-[0_0_10px_rgba(0,240,255,0.5)] animate-bounce">
                  🔍 {comment || 'AI SCAN: 分析完了'}
                </div>
              )}

              {/* 削除ボタン */}
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onClick={(e) => handleDeleteNode(node.id, e)}
                className="absolute top-1.5 right-2 z-50 text-slate-400 hover:text-rose-400 text-[11px] bg-black/50 px-2 py-1 rounded-full transition-colors"
                title="削除"
              >
                ✕
              </button>
            </div>
          );
        })}
      </main>

      {/* AIからの回答パネル（report ツール） */}
      {report && (
        <div className="fixed bottom-44 left-3 right-3 z-40 max-w-2xl mx-auto">
          <div className="bg-[#0a1128]/95 backdrop-blur-2xl border border-fuchsia-400/70 rounded-2xl p-4 shadow-[0_0_30px_rgba(217,70,239,0.25)]">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-bold text-fuchsia-300 tracking-widest">🧠 JARVIS REPORT</span>
              <button type="button" onClick={() => setReport(null)} className="text-slate-400 hover:text-white text-xs px-2 py-0.5">
                [ 閉じる ✕ ]
              </button>
            </div>
            <div className="max-h-[40vh] overflow-y-auto text-xs md:text-sm text-slate-100 whitespace-pre-wrap leading-relaxed select-text">
              {report}
            </div>
          </div>
        </div>
      )}

      {isInputOpen && (
        <div className="fixed bottom-28 left-3 right-3 z-40 max-w-2xl mx-auto">
          <form
            onSubmit={handleQuickAdd}
            className="bg-[#0a1128]/95 backdrop-blur-2xl border border-[#00f0ff] rounded-2xl p-4 shadow-[0_0_30px_rgba(0,240,255,0.3)] flex flex-col gap-3"
          >
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold text-[#00f0ff] tracking-widest">🧠 ORB INJECTOR (ノード生成)</span>
              <button
                type="button"
                onClick={() => setIsInputOpen(false)}
                className="text-slate-400 hover:text-white text-xs px-2 py-0.5"
              >
                [ 閉じる ✕ ]
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {quickSlots.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  onClick={() => appendSlotTag(slot)}
                  className="text-[10px] px-2.5 py-1 rounded-full bg-[#030712] border border-[#00f0ff]/40 text-[#00f0ff] hover:bg-[#00f0ff]/20 active:scale-95 transition-all"
                >
                  {slot}
                </button>
              ))}
            </div>

            <textarea
              value={rawInputContent}
              onChange={(e) => setRawInputContent(e.target.value)}
              placeholder="例: @アイデア @企画開発 カフェの新作ドリンク案..."
              rows={3}
              autoFocus
              className="bg-[#030712] border border-[#00f0ff]/40 rounded-xl p-3 text-xs md:text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#00f0ff] resize-none"
            />
            <div className="flex justify-between items-center text-[10px] text-slate-400">
              <span>複数タグ対応</span>
              <button
                type="submit"
                className="bg-[#00f0ff] text-[#030712] px-5 py-2 rounded-xl text-xs font-extrabold tracking-wider hover:bg-[#00f0ff]/80 active:scale-95 transition-all shadow-[0_0_10px_rgba(0,240,255,0.5)]"
              >
                オーブを生成 🚀
              </button>
            </div>
          </form>
        </div>
      )}

      <footer className="fixed bottom-0 left-0 right-0 z-30 bg-[#030712]/95 backdrop-blur-xl border-t border-[#00f0ff33] p-3 md:p-4">
        {loading && <div className="absolute top-0 left-0 right-0 h-0.5 bg-[#00f0ff] animate-pulse" />}
        <div className="max-w-4xl mx-auto flex flex-col gap-2">
          <div className="flex justify-between items-center text-[10px] md:text-xs text-slate-400">
            <div className="flex items-center gap-2 truncate">
              <span className="text-[#00f0ff] font-bold">JARVIS:</span>
              <span className="truncate">
                {loading
                  ? `⏳ ${loadingLabel} … ${elapsed}秒${elapsed >= 20 ? '（AIの応答待ち。70秒で打ち切ります）' : ''}`
                  : systemLog}
              </span>
            </div>

            {!isInputOpen && (
              <button
                type="button"
                onClick={() => setIsInputOpen(true)}
                className="bg-[#00f0ff]/15 border border-[#00f0ff]/60 text-[#00f0ff] px-3 py-1 rounded-full text-[11px] font-bold hover:bg-[#00f0ff]/30 active:scale-95 transition-all shadow-[0_0_10px_rgba(0,240,255,0.2)] flex items-center gap-1.5 shrink-0"
              >
                <span>＋</span> オーブを書く
              </button>
            )}
          </div>

          {/* 🛰 先回り提案 */}
          {whisper && (
            <div className="flex items-center gap-2 text-[10px] md:text-xs bg-fuchsia-950/40 border border-fuchsia-400/50 rounded-xl px-3 py-1.5">
              <span className="flex-1 text-fuchsia-200">🛰 {whisper.message}</span>
              {whisper.command && (
                <button
                  type="button"
                  onClick={() => {
                    const c = whisper.command as string;
                    setWhisper(null);
                    runCommand(c);
                  }}
                  className="shrink-0 border border-fuchsia-300 text-fuchsia-200 px-2 py-0.5 rounded-full hover:bg-fuchsia-400/20 active:scale-95"
                >
                  ▶ 実行
                </button>
              )}
              <button type="button" onClick={() => setWhisper(null)} className="shrink-0 text-slate-400 hover:text-white px-1">
                ✕
              </button>
            </div>
          )}

          {/* ⚡ マクロ（保存した指令。AIを使わず即実行） */}
          {macroOpen && (
            <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
              {macros.length === 0 && (
                <span className="text-[10px] text-slate-500">
                  マクロはまだありません。指令を実行したあと「💾 保存」で登録できます（条件だけの指令が対象）
                </span>
              )}
              {macros.map((m) => (
                <span key={m.id} className="inline-flex items-center rounded-full border border-[#00f0ff]/50 bg-[#0a1128] text-[10px]">
                  <button type="button" onClick={() => runMacro(m)} disabled={loading} className="px-2.5 py-1 hover:bg-[#00f0ff]/20 rounded-l-full">
                    ⚡ {m.name}
                  </button>
                  <button type="button" onClick={() => deleteMacro(m)} className="px-1.5 py-1 text-slate-500 hover:text-rose-400 rounded-r-full" title="削除">
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 text-[10px]">
            <button type="button" onClick={() => setMacroOpen((v) => !v)} className={headerBtn}>
              ⚡ マクロ{macros.length ? ` ${macros.length}` : ''}
            </button>
            {lastRun && (
              <button type="button" onClick={saveMacro} className={headerBtn} title="直前の指令をマクロとして保存">
                💾 保存
              </button>
            )}
            <button
              type="button"
              onClick={toggleWhisper}
              className={`${headerBtn} ${whisperOn ? 'bg-fuchsia-400/20 border-fuchsia-300 text-fuchsia-200' : ''}`}
              title="ノードを追加したとき、似たものがあればAIが提案します（無料枠を節約するため既定はOFF）"
            >
              🛰 先回り {whisperOn ? 'ON' : 'OFF'}
            </button>
          </div>

          <form onSubmit={handleCommandSubmit} className="flex gap-2">
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="JARVIS指令 (例: 期限が近いものを教えて / 優先度マトリクスにして / テーマごとにまとめて)..."
              disabled={loading}
              className="flex-1 bg-[#0a1128] border border-[#00f0ff]/40 rounded-xl px-3.5 py-2.5 text-xs md:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[#00f0ff]"
            />
            {loading ? (
              <button
                type="button"
                onClick={cancelRunning}
                className="bg-rose-500/20 border border-rose-400 text-rose-200 px-5 py-2.5 rounded-xl text-xs md:text-sm font-bold tracking-wider hover:bg-rose-500/30 active:scale-95 transition-all"
              >
                ■ 中断
              </button>
            ) : (
              <button
                type="submit"
                className="bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] px-5 py-2.5 rounded-xl text-xs md:text-sm font-bold tracking-wider hover:bg-[#00f0ff]/30 active:scale-95 transition-all"
              >
                EXEC
              </button>
            )}
          </form>
        </div>
      </footer>
    </div>
  );
}
