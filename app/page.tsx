'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DeskNode, ViewDirective, ViewLayout } from '@/lib/desk/types';
import NodeSheet, { type SheetPatch } from '@/lib/desk/ui/NodeSheet';
import { overviewSuggestions, suggestionsForNewNode, type Suggestion } from '@/lib/desk/insights';
import { computeViewPositions } from '@/lib/desk/layoutPositions';
import { daysUntil, toDateTime } from '@/lib/desk/selector';

interface StarkNode {
  id: string;
  content: string;
  category: string;
  color: string; // cyan / blue / violet / pink / crimson / orange / amber / lime / emerald / slate
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
    stack?: string; // 重ねている山のID（同じIDは一緒に動く）
    editedAt?: string; // 本文を編集した日時
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

/** 色ごとの見た目（Tailwind は完全なクラス名が必要なので、文字列をそのまま並べている） */
const COLOR_STYLES: Record<string, string> = {
  cyan: 'border-[#00f0ff]/80 text-[#00f0ff] shadow-[0_0_25px_rgba(0,240,255,0.35)] bg-gradient-to-br from-[#001525]/90 to-[#0a1128]/95',
  blue: 'border-blue-400/80 text-blue-300 shadow-[0_0_25px_rgba(59,130,246,0.4)] bg-gradient-to-br from-[#0b1633]/90 to-[#0a1128]/95',
  violet: 'border-violet-400/80 text-violet-300 shadow-[0_0_25px_rgba(167,139,250,0.4)] bg-gradient-to-br from-[#170f2e]/90 to-[#0a1128]/95',
  pink: 'border-pink-400/80 text-pink-300 shadow-[0_0_25px_rgba(244,114,182,0.4)] bg-gradient-to-br from-[#2a0f1f]/90 to-[#0a1128]/95',
  crimson: 'border-rose-500 text-rose-300 shadow-[0_0_30px_rgba(244,63,94,0.5)] animate-pulse bg-gradient-to-br from-[#200008]/95 to-[#0a1128]/95',
  orange: 'border-orange-400/80 text-orange-300 shadow-[0_0_25px_rgba(251,146,60,0.4)] bg-gradient-to-br from-[#241005]/90 to-[#0a1128]/95',
  amber: 'border-amber-400/80 text-amber-300 shadow-[0_0_25px_rgba(251,191,36,0.35)] bg-gradient-to-br from-[#1a1500]/90 to-[#0a1128]/95',
  lime: 'border-lime-400/80 text-lime-300 shadow-[0_0_25px_rgba(163,230,53,0.4)] bg-gradient-to-br from-[#14200a]/90 to-[#0a1128]/95',
  emerald: 'border-emerald-400/80 text-emerald-300 shadow-[0_0_25px_rgba(52,211,153,0.35)] bg-gradient-to-br from-[#002010]/90 to-[#0a1128]/95',
  slate: 'border-slate-400/70 text-slate-300 shadow-[0_0_18px_rgba(148,163,184,0.3)] bg-gradient-to-br from-[#141a26]/90 to-[#0a1128]/95',
};

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
const TIME_KEY = 'mark1desk.showTime';
const POS_KEY = 'mark1desk.positions.v1'; // 自由配置の位置を端末ごとに保存（リロードしても崩れない）
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
  // 現在時刻は描画中ではなく、起動後（ブラウザ側）に取得して1分ごとに更新する
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('');
  const [elapsed, setElapsed] = useState(0); // 実行中の経過秒数（止まっているのか待っているのか分かるように）
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]); // いま一緒に動かしているオーブ
  const dragGroup = useRef<{ ids: string[]; base: Record<string, Pos>; start: { x: number; y: number } } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // Shift+クリック／選択モードで選んだオーブ
  const [selectMode, setSelectMode] = useState(false);
  const [showTime, setShowTime] = useState(true); // 記入した時刻をオーブに表示
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
  const [whisperOn, setWhisperOn] = useState(true); // 先回り提案（既定ON。AIの呼び出しは関連ノードがあるときだけ・1時間に上限あり）
  const [addSuggestions, setAddSuggestions] = useState<Suggestion[]>([]);
  const [whisperStatus, setWhisperStatus] = useState(false); // AIが分析中
  const [whisperNote, setWhisperNote] = useState('');
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // 💡 タップで開く編集シート / タグの絞り込み / 音声入力
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [voiceOk, setVoiceOk] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const dragStart = useRef<{ id: string; pos: Pos; t: number } | null>(null);

  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    try {
      if (localStorage.getItem(WHISPER_KEY) === '0') setWhisperOn(false);
      if (localStorage.getItem(TIME_KEY) === '0') setShowTime(false);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleWhisper = () => {
    setWhisperOn((v) => {
      try {
        localStorage.setItem(WHISPER_KEY, v ? '0' : '1');
      } catch {
        /* noop */
      }
      return !v;
    });
    setAddSuggestions([]);
  };

  useEffect(() => {
    const w = window as any;
    setVoiceOk(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  const orb = view ? VIEW_ORB : isDesktop ? 192 : 176;
  const compact = !!view;
  const hiddenSet = useMemo(() => new Set(view?.hiddenIds ?? []), [view]);
  const archivedCount = useMemo(() => nodes.filter((n) => n.metadata?.archived).length, [nodes]);
  const visibleNodes = useMemo(() => (showArchived ? nodes : nodes.filter((n) => !n.metadata?.archived)), [nodes, showArchived]);

  // 山（スタック）：同じ metadata.stack を持つ2件以上のオーブ
  const stacks = useMemo(() => {
    const m = new Map<string, string[]>();
    visibleNodes.forEach((n) => {
      const sid = n.metadata?.stack;
      if (sid) m.set(sid, [...(m.get(sid) ?? []), n.id]);
    });
    [...m.entries()].forEach(([k, v]) => v.length < 2 && m.delete(k));
    return m;
  }, [visibleNodes]);

  const nodeTagsOf = (n: StarkNode) => (n.metadata?.tags && n.metadata.tags.length > 0 ? n.metadata.tags : [n.category]);
  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  // 💡 先回り提案：AIを使わない見張り（期限・重複）＋ノード追加時の提案
  const insights = useMemo(
    () => (whisperOn && now ? overviewSuggestions(nodes as unknown as DeskNode[], now) : []),
    [nodes, whisperOn, now]
  );
  const visibleSuggestions = useMemo(
    () => [...addSuggestions, ...insights].filter((s) => !dismissed.has(s.id)).slice(0, 2),
    [addSuggestions, insights, dismissed]
  );
  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));

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

  const readSavedPositions = (): Record<string, Pos> => {
    try {
      return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}');
    } catch {
      return {};
    }
  };

  const fetchNodes = async (forceRelayout = false) => {
    const { data: nodeData } = await supabase.from('stark_nodes').select('*').order('created_at', { ascending: false });
    if (nodeData) {
      setNodes(nodeData);
      const live = nodeData.filter((n: StarkNode) => !n.metadata?.archived);
      if (forceRelayout) {
        relayoutNodes(live);
      } else if (Object.keys(nodePositions).length === 0) {
        // 起動時：前回の配置を復元（無いノードだけ後で補完）
        const saved = readSavedPositions();
        const known: Record<string, Pos> = {};
        live.forEach((n: StarkNode) => {
          if (saved[n.id]) known[n.id] = saved[n.id];
        });
        if (Object.keys(known).length) setNodePositions(known);
        else relayoutNodes(live);
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

  // 自由配置の位置を保存（整列表示中は一時的な位置なので保存しない）
  useEffect(() => {
    if (view || Object.keys(nodePositions).length === 0 || nodes.length === 0) return;
    const t = setTimeout(() => {
      try {
        const ids = new Set(nodes.map((n) => n.id));
        const keep: Record<string, Pos> = {};
        (Object.entries(nodePositions) as [string, Pos][]).forEach(([id, p]) => {
          if (ids.has(id)) keep[id] = p;
        });
        localStorage.setItem(POS_KEY, JSON.stringify(keep));
      } catch {
        /* 保存できない環境では何もしない */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [nodePositions, nodes, view]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace('/login');
        return;
      }
      setAuthed(true);
      fetchNodes(false);
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
    const t = data.timing;
    const timing = t
      ? t.local
        ? ' ⚡ローカル実行（AIなし）'
        : ` ⏱AI ${(t.planMs / 1000).toFixed(1)}秒${t.model ? `・${t.model}` : ''}`
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
    // 重ねる／ばらす（位置は端末側が持つので、ここで動かす）
    if (data.ui?.length) {
      if (view) clearView(true);
      for (const a of data.ui as { type: string; groups?: { id: string; ids: string[] }[]; ids?: string[] }[]) {
        if (a.type === 'stack' && a.groups) applyStack(a.groups);
        if (a.type === 'spread' && a.ids) applySpread(a.ids);
      }
    }
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
    abortRef.current?.abort(); // サーバー側にも伝わり、まだ実行していない手順は実行されない
    // サーバーが途中まで実行していた場合に備えて、少し待って最新の状態を読み直す
    setTimeout(() => fetchNodes(), 1200);
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
      .select('*')
      .single();

    if (!error && created) {
      const before = nodes; // 追加前のノード一覧（重複・関連の判定用）
      setRawInputContent('');
      setIsInputOpen(false);
      clearView(false); // 新規投入後は円形の自動整列に戻る
      await fetchNodes(true);
      setSystemLog('ORB MATRIX EXPANDED.');

      // 🛰 先回り提案：① AIなしの提案をすぐ出す ② 関連ノードがあればAIが追加提案（サーバー側で判定）
      if (whisperOn) {
        const local = suggestionsForNewNode(created as unknown as DeskNode, before as unknown as DeskNode[]);
        setAddSuggestions(local);
        setWhisperNote('');
        setWhisperStatus(true);
        post({ action: 'whisper', nodeId: created.id }, false)
          .then((d) => {
            const ai: Suggestion[] = (d?.whispers ?? []).map((w: { message: string; command: string }, i: number) => ({
              id: `ai:${created.id}:${i}`,
              source: 'ai' as const,
              message: w.message,
              command: w.command,
            }));
            if (ai.length) setAddSuggestions((prev) => [...ai, ...prev].slice(0, 5));
            else {
              const reason: Record<string, string> = {
                no_related: '関連するノードがまだ無いため、AIの提案はありません',
                none: 'AIの提案はありませんでした',
                rate_limited: 'AI提案の1時間あたりの上限に達しました',
              };
              setWhisperNote(d?.error ? `🛰 先回り: ${d.error}` : `🛰 ${reason[d?.reason] ?? 'AIの提案はありませんでした'}`);
              setTimeout(() => setWhisperNote(''), 6000);
            }
          })
          .finally(() => setWhisperStatus(false));
      }
    } else {
      setSystemLog(`ERROR: ${error?.message ?? '追加に失敗しました'}`);
    }
  };

  const appendSlotTag = (tag: string) => {
    setRawInputContent((prev) => {
      if (prev.includes(tag)) return prev;
      return prev ? `${tag} ${prev}` : `${tag} `;
    });
  };

  const deleteNodeById = async (id: string) => {
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
    setSelectedId(null);
    await fetchNodes();
    setSystemLog('ORB EXPUNGED.');
  };

  const handleDeleteNode = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    return deleteNodeById(id);
  };

  /** 編集シートの保存（AIなし・即時）。metadata は既存値に重ねて書く */
  const updateNode = async (id: string, columns: Record<string, unknown>, meta: Record<string, unknown>, doneMsg: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const metadata: Record<string, unknown> = { ...(node.metadata ?? {}) };
    Object.entries(meta).forEach(([k, v]) => {
      if (v === null || v === '' || v === false) delete metadata[k];
      else metadata[k] = v;
    });
    const { data, error } = await supabase.from('stark_nodes').update({ ...columns, metadata }).eq('id', id).select('id');
    if (error) setSystemLog(`ERROR: 保存に失敗: ${error.message}`);
    else if (!data || data.length === 0) setSystemLog('ERROR: 保存できませんでした（Supabase の RLS に UPDATE の許可が無い可能性）');
    else {
      setSelectedId(null);
      await fetchNodes();
      setSystemLog(doneMsg);
    }
  };

  const saveSheet = (id: string, p: SheetPatch) =>
    updateNode(
      id,
      { content: p.content, color: p.color, category: p.category },
      { tags: p.tags, due: p.due, stage: p.stage, pinned: p.pinned },
      'ORB UPDATED.'
    );

  const toggleArchive = (id: string) => {
    const archived = !!nodes.find((n) => n.id === id)?.metadata?.archived;
    return updateNode(id, {}, { archived: archived ? null : true }, archived ? 'ORB RESTORED.' : 'ORB ARCHIVED.');
  };

  /** いっしょに動かすオーブ：選択中ならその全部、山に入っていれば山ごと、それ以外は自分だけ */
  const groupOf = (id: string): string[] => {
    if (selected.has(id)) return [...selected];
    const sid = nodes.find((n) => n.id === id)?.metadata?.stack;
    const members = sid ? stacks.get(sid) : undefined;
    return members ?? [id];
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startDrag = (id: string, clientX: number, clientY: number, additive = false) => {
    if (additive) {
      toggleSelect(id); // Shift（または Ctrl/⌘）+クリック：選択のON/OFFだけ
      return;
    }
    const ids = groupOf(id);
    const base: Record<string, Pos> = {};
    ids.forEach((i) => (base[i] = nodePositions[i] || { x: 20, y: 20 }));
    dragGroup.current = { ids, base, start: { x: clientX, y: clientY } };
    setDragIds(ids);
    setDraggingId(id);
    dragStart.current = { id, pos: base[id], t: Date.now() };
  };

  const moveDrag = (clientX: number, clientY: number) => {
    const g = dragGroup.current;
    if (!draggingId || !g) return;
    const dx = clientX - g.start.x;
    const dy = clientY - g.start.y;
    setNodePositions((prev) => {
      const next = { ...prev };
      g.ids.forEach((i) => (next[i] = { x: g.base[i].x + dx, y: g.base[i].y + dy }));
      return next;
    });
  };

  // ほぼ動かさずに離した＝タップ → 編集シート（選択モード中は選択のON/OFF）
  const endDrag = () => {
    const st = dragStart.current;
    dragStart.current = null;
    dragGroup.current = null;
    if (draggingId && st && st.id === draggingId) {
      const p = nodePositions[draggingId];
      if (p && Math.hypot(p.x - st.pos.x, p.y - st.pos.y) < 6 && Date.now() - st.t < 500) {
        if (selectMode) toggleSelect(draggingId);
        else setSelectedId(draggingId);
      }
    }
    setDraggingId(null);
    setDragIds([]);
  };

  const clearSelection = () => setSelected(new Set());

  /** 重ねる：位置を1か所に寄せて、少しずつずらして積む。groups が複数なら、山を並べて置く */
  const applyStack = (groups: { id: string; ids: string[] }[]) => {
    const width = mainRef.current?.clientWidth ?? 390;
    const o = isDesktop ? 192 : 176;
    setNodePositions((prev) => {
      const next = { ...prev };
      groups.forEach((g, gi) => {
        let px: number;
        let py: number;
        if (groups.length === 1) {
          const pts = g.ids.map((i) => prev[i]).filter(Boolean);
          px = pts.length ? pts.reduce((a, p) => a + p.x, 0) / pts.length : 60;
          py = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : 100;
        } else {
          const perRow = Math.max(1, Math.floor((width - 40) / (o + 70)));
          px = 30 + (gi % perRow) * (o + 70);
          py = 90 + Math.floor(gi / perRow) * (o + 90);
        }
        g.ids.forEach((id, i) => (next[id] = { x: Math.max(10, px) + i * 9, y: Math.max(70, py) + i * 9 }));
      });
      return next;
    });
  };

  /** ばらす：山の中心のまわりに円状に広げる */
  const applySpread = (ids: string[]) => {
    setNodePositions((prev) => {
      const next = { ...prev };
      const pts = ids.map((i) => prev[i]).filter(Boolean);
      const cx = pts.length ? pts.reduce((a, p) => a + p.x, 0) / pts.length : 200;
      const cy = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : 250;
      const r = Math.max(150, ids.length * 30);
      ids.forEach((id, i) => {
        const a = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
        next[id] = { x: Math.max(10, cx + Math.cos(a) * r), y: Math.max(70, cy + Math.sin(a) * r) };
      });
      return next;
    });
  };

  /** 複数オーブの metadata をまとめて更新（Shift選択の操作用） */
  const metaUpdate = async (ids: string[], meta: Record<string, unknown>) => {
    const results = await Promise.all(
      ids.map((id) => {
        const n = nodes.find((x) => x.id === id);
        if (!n) return Promise.resolve({ error: null, data: [{ id }] });
        const metadata: Record<string, unknown> = { ...(n.metadata ?? {}) };
        Object.entries(meta).forEach(([k, v]) => {
          if (v === null || v === '' || v === false) delete metadata[k];
          else metadata[k] = v;
        });
        return supabase.from('stark_nodes').update({ metadata }).eq('id', id).select('id');
      })
    );
    const bad = results.find((r: any) => r.error || !r.data?.length);
    if (bad) {
      setSystemLog(`ERROR: 更新に失敗しました（${(bad as any).error?.message ?? 'RLS の UPDATE 許可を確認'}）`);
      return false;
    }
    await fetchNodes();
    return true;
  };

  const stackSelected = async () => {
    const ids = [...selected];
    if (ids.length < 2) return;
    const sid = `s${Date.now().toString(36)}`;
    if (view) clearView(true);
    if (await metaUpdate(ids, { stack: sid })) {
      applyStack([{ id: sid, ids }]);
      clearSelection();
      setSystemLog(`STACKED: ${ids.length}件を重ねました。ドラッグで一緒に動きます`);
    }
  };

  const unstackIds = async (ids: string[]) => {
    if (await metaUpdate(ids, { stack: null })) {
      applySpread(ids);
      setSystemLog('UNSTACKED: 重なりをばらしました');
    }
  };

  const bulkDeleteSelected = async () => {
    const ids = [...selected];
    if (!ids.length || !window.confirm(`選択した${ids.length}件を削除しますか？`)) return;
    const { data, error } = await supabase.from('stark_nodes').delete().in('id', ids).select('id');
    if (error || !data?.length) {
      setSystemLog(`ERROR: 削除できませんでした（${error?.message ?? 'RLS の DELETE 許可を確認'}）`);
      return;
    }
    clearSelection();
    await fetchNodes();
    setSystemLog(`DELETED: ${data.length}件を削除しました`);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(nodes, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mark1-desk-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setSystemLog('EXPORTED: 全ノードをJSONで書き出しました。');
  };

  const toggleVoice = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => setCommand(Array.from(e.results).map((r: any) => r[0].transcript).join(''));
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

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
          <button
            onClick={() => {
              setSelectMode((v) => !v);
              if (selectMode) clearSelection();
            }}
            className={`${headerBtn} ${selectMode ? 'bg-yellow-300/20 border-yellow-300 text-yellow-200' : ''}`}
            title="選択モード：タップで複数選んで、まとめて動かす・重ねる（PCは Shift+クリックでも選べます）"
          >
            ☑ 選択
          </button>
          <button
            onClick={() => {
              setShowTime((v) => {
                try {
                  localStorage.setItem(TIME_KEY, v ? '0' : '1');
                } catch {
                  /* noop */
                }
                return !v;
              });
            }}
            className={headerBtn}
            title="記入した時刻の表示を切り替え"
          >
            🕒
          </button>
          <button onClick={exportJson} className={headerBtn} title="全ノードをJSONで書き出し（バックアップ）">
            ⬇
          </button>
          <button onClick={handleLogout} className={headerBtn} title="ログアウト">
            ⏻
          </button>
        </div>
      </header>

      {/* 選択中のアクション（まとめて動かす・重ねる） */}
      {selected.size > 0 && (
        <div className="relative z-30 flex items-center gap-2 px-4 py-1.5 text-[10px] bg-yellow-950/40 border-b border-yellow-300/40 text-yellow-100 overflow-x-auto">
          <span className="shrink-0 font-bold">☑ {selected.size}件を選択中（ドラッグでまとめて移動）</span>
          <button type="button" onClick={stackSelected} disabled={selected.size < 2} className="shrink-0 border border-yellow-300/70 px-2 py-0.5 rounded-full hover:bg-yellow-300/20 disabled:opacity-40">
            ⧉ 重ねる
          </button>
          <button type="button" onClick={() => unstackIds([...selected])} className="shrink-0 border border-yellow-300/70 px-2 py-0.5 rounded-full hover:bg-yellow-300/20">
            ⤢ ばらす
          </button>
          <button type="button" onClick={bulkDeleteSelected} className="shrink-0 border border-rose-400/70 text-rose-200 px-2 py-0.5 rounded-full hover:bg-rose-500/20">
            削除
          </button>
          <button type="button" onClick={clearSelection} className="shrink-0 ml-auto text-slate-300 hover:text-white px-1">
            ✕ 選択解除
          </button>
        </div>
      )}

      {/* タグ絞り込み（画面だけで切り替わる。AIを使わない） */}
      {quickSlots.length > 0 && !view && (
        <div className="relative z-20 flex gap-1.5 overflow-x-auto px-4 py-1.5 border-b border-[#00f0ff]/15 bg-[#030712]/70">
          {[null, ...quickSlots].map((slot) => {
            const tag = slot ? slot.slice(1) : null;
            const on = tagFilter === tag;
            return (
              <button
                key={slot ?? 'ALL'}
                type="button"
                onClick={() => setTagFilter(on ? null : tag)}
                className={`shrink-0 text-[10px] px-2.5 py-0.5 rounded-full border transition-all ${
                  on ? 'bg-[#00f0ff]/25 border-[#00f0ff] text-white' : 'border-[#00f0ff]/30 text-[#00f0ff]/80 hover:bg-[#00f0ff]/10'
                }`}
              >
                {slot ?? 'ALL'}
              </button>
            );
          })}
        </div>
      )}

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
      <main
        ref={mainRef}
        className="relative z-10 flex-1 w-full h-[calc(100vh-205px)] overflow-auto"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
        onTouchStart={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
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
          const filteredOut = !!tagFilter && !nodeTagsOf(node).includes(tagFilter);
          const isHidden = (hiddenSet.has(node.id) && !node.metadata?.archived) || filteredOut;
          const isArchived = !!node.metadata?.archived;
          const commentMode = node.metadata?.commentMode;
          const comment = node.metadata?.comment;
          const opacity = isArchived ? 0.4 : node.metadata?.opacity ?? 1;
          const tags = node.metadata?.tags && node.metadata.tags.length > 0 ? node.metadata.tags : [node.category];

          // 期限バッジ（AIを使わず、画面側で常に計算する）
          const due = node.metadata?.due;
          const left = due && now ? daysUntil(due, now) : NaN;
          const done = node.metadata?.stage === '完了';
          const dueClass =
            Number.isNaN(left) || done
              ? 'text-slate-400'
              : left < 0
              ? 'text-rose-300 border-rose-400'
              : left <= 3
              ? 'text-amber-300 border-amber-400'
              : 'text-slate-300';

          const orbColor = COLOR_STYLES[node.color] ?? COLOR_STYLES.cyan;

          // 山（スタック）：先頭が一番手前。ドラッグ中は全員を最前面に
          const stackIds = node.metadata?.stack ? stacks.get(node.metadata.stack) : undefined;
          const stackIdx = stackIds ? stackIds.indexOf(node.id) : -1;
          const inDrag = dragIds.includes(node.id);
          const stackZ = inDrag ? 60 + (stackIds ? stackIds.length - stackIdx : 0) : stackIds ? 10 + (stackIds.length - stackIdx) : undefined;
          const isSelected = selected.has(node.id);
          const isDone = node.metadata?.stage === '完了';

          return (
            <div
              key={node.id}
              onMouseDown={(e) => startDrag(node.id, e.clientX, e.clientY, e.shiftKey || e.ctrlKey || e.metaKey)}
              onTouchStart={(e) => {
                if (e.touches[0]) startDrag(node.id, e.touches[0].clientX, e.touches[0].clientY);
              }}
              style={{
                width: orb,
                height: orb,
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                opacity: isHidden ? 0 : opacity,
                pointerEvents: isHidden ? 'none' : undefined,
                zIndex: stackZ,
              }}
              // 💡 まん丸ではなく「四角めで角が丸い」形（rounded-[28px]）。移動はドラッグ中だけアニメ無し
              className={`absolute top-0 left-0 cursor-grab active:cursor-grabbing rounded-[28px] backdrop-blur-2xl border flex flex-col items-center justify-center p-3 text-center ${
                inDrag ? '' : 'transition-[transform,opacity,box-shadow] duration-500 ease-out motion-reduce:transition-none'
              } ${orbColor} ${isArchived ? 'border-dashed' : ''} ${isSelected ? 'ring-2 ring-yellow-300' : ''} ${
                draggingId === node.id
                  ? 'z-40 scale-110 shadow-[0_0_40px_rgba(0,240,255,0.7)]'
                  : isHighlight
                  ? 'scale-105 ring-2 ring-[#00f0ff] z-20'
                  : isScanned
                  ? 'ring-1 ring-amber-300/60 z-10'
                  : 'z-10'
              }`}
            >
              {/* 左上：編集（✎）／完了トグル（✓）／ピンの印 */}
              <div className="absolute top-1.5 left-2 flex items-center gap-1">
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(node.id);
                  }}
                  className="text-[10px] leading-none px-1.5 py-1 rounded-full bg-black/50 text-slate-300 hover:text-white"
                  title="編集（本文・期限・色など）"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    updateNode(node.id, {}, { stage: isDone ? '未着手' : '完了' }, isDone ? 'REOPENED.' : 'DONE.');
                  }}
                  className={`text-[10px] leading-none px-1.5 py-1 rounded-full bg-black/50 ${isDone ? 'text-emerald-300' : 'text-slate-400 hover:text-emerald-300'}`}
                  title={isDone ? '未着手に戻す' : '完了にする'}
                >
                  ✓
                </button>
                {node.metadata?.pinned && <span className="text-[10px]">📌</span>}
              </div>
              {isSelected && <span className="absolute -top-2 -right-2 text-[11px] bg-yellow-300 text-black rounded-full w-5 h-5 flex items-center justify-center font-bold">✔</span>}
              {stackIds && stackIdx === 0 && (
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    unstackIds(stackIds);
                  }}
                  className="absolute -bottom-3 left-1/2 -translate-x-1/2 text-[9px] px-2 py-0.5 rounded-full bg-fuchsia-950/90 border border-fuchsia-300 text-fuchsia-200 hover:bg-fuchsia-500/30 whitespace-nowrap"
                  title="重なりをばらす"
                >
                  ×{stackIds.length} ⤢ ばらす
                </button>
              )}

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

              {showTime && (
                <div className="mt-0.5 text-[8px] text-slate-500 tracking-wide">🕒 {toDateTime(node.created_at).slice(5).replace('-', '/')}</div>
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

      {selectedNode && (
        <NodeSheet
          key={selectedNode.id}
          node={selectedNode}
          onClose={() => setSelectedId(null)}
          onSave={(p) => saveSheet(selectedNode.id, p)}
          onToggleArchive={() => toggleArchive(selectedNode.id)}
          onDelete={() => deleteNodeById(selectedNode.id)}
        />
      )}

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

          {/* 🛰 先回り提案（💡=AIなしの即時提案 / 🛰=AIの提案） */}
          {(visibleSuggestions.length > 0 || whisperStatus || whisperNote) && (
            <div className="flex flex-col gap-1">
              {whisperStatus && <div className="text-[10px] text-fuchsia-300 animate-pulse">🛰 先回り分析中…</div>}
              {whisperNote && <div className="text-[10px] text-slate-400">{whisperNote}</div>}
              {visibleSuggestions.map((sg) => (
                <div
                  key={sg.id}
                  className="flex items-center gap-2 text-[10px] md:text-xs bg-fuchsia-950/40 border border-fuchsia-400/50 rounded-xl px-3 py-1.5"
                >
                  <span className="flex-1 text-fuchsia-200 truncate">
                    {sg.source === 'ai' ? '🛰' : '💡'} {sg.message}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(sg.id);
                      runCommand(sg.command);
                    }}
                    disabled={loading}
                    className="shrink-0 border border-fuchsia-300 text-fuchsia-200 px-2 py-0.5 rounded-full hover:bg-fuchsia-400/20 active:scale-95 disabled:opacity-40"
                  >
                    ▶ 実行
                  </button>
                  <button type="button" onClick={() => dismiss(sg.id)} className="shrink-0 text-slate-400 hover:text-white px-1">
                    ✕
                  </button>
                </div>
              ))}
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
              placeholder="指令 (例: タスクを重ねて / 夜に書いたものを一覧 / 期限を明日に / 今日やること)..."
              disabled={loading}
              className="flex-1 bg-[#0a1128] border border-[#00f0ff]/40 rounded-xl px-3.5 py-2.5 text-xs md:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[#00f0ff]"
            />
            {voiceOk && !loading && (
              <button
                type="button"
                onClick={toggleVoice}
                className={`px-3 py-2.5 rounded-xl border text-sm active:scale-95 transition-all ${
                  listening ? 'bg-rose-500/30 border-rose-400 text-rose-200 animate-pulse' : 'border-[#00f0ff]/50 text-[#00f0ff] hover:bg-[#00f0ff]/10'
                }`}
                title="音声で指令（日本語）"
              >
                {listening ? '⏹' : '🎤'}
              </button>
            )}
            {loading ? (
              <button
                key="cancel"
                type="button"
                onClick={cancelRunning}
                className="bg-rose-500/20 border border-rose-400 text-rose-200 px-5 py-2.5 rounded-xl text-xs md:text-sm font-bold tracking-wider hover:bg-rose-500/30 active:scale-95 transition-all"
              >
                ■ 中断
              </button>
            ) : (
              <button
                key="exec"
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
