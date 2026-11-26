'use client';

import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

/*
 * バックアップから「統合」する画面。今あるノードは変更・削除せず、足りないものだけを追加する。
 *   ・JSONファイル（⬇で書き出したもの）を読み込む
 *   ・自動バックアップ（1時間ごと・この端末／サーバー）から選ぶ
 */

export interface BackupRow {
  id: string;
  content: string;
  category?: string;
  color?: string;
  status?: string;
  metadata?: Record<string, any>;
  created_at?: string;
}

interface ServerBackup {
  id: string;
  taken_at: string;
}
interface LocalBackup {
  t: number;
  nodes: BackupRow[];
}

const when = (iso: string | number) =>
  new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function BackupSheet({
  currentNodes,
  localKey,
  onClose,
  onMerge,
}: {
  currentNodes: { id: string; content: string }[];
  localKey: string;
  onClose: () => void;
  onMerge: (rows: BackupRow[], label: string) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<{ rows: BackupRow[]; label: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverList, setServerList] = useState<ServerBackup[]>([]);
  const [localList, setLocalList] = useState<LocalBackup[]>([]);

  useEffect(() => {
    try {
      setLocalList((JSON.parse(localStorage.getItem(localKey) ?? '[]') as LocalBackup[]).slice().reverse());
    } catch {
      /* noop */
    }
    supabase
      .from('desk_backups')
      .select('id, taken_at')
      .order('taken_at', { ascending: false })
      .limit(30)
      .then(({ data }) => setServerList((data ?? []) as ServerBackup[]));
  }, [localKey]);

  const validate = (rows: unknown): BackupRow[] | null => {
    if (!Array.isArray(rows)) return null;
    const ok = rows.filter((r) => r && typeof r === 'object' && typeof (r as BackupRow).id === 'string' && typeof (r as BackupRow).content === 'string');
    return ok.length ? (ok as BackupRow[]) : null;
  };

  const onFile = async (f: File | undefined) => {
    setError('');
    if (!f) return;
    try {
      const rows = validate(JSON.parse(await f.text()));
      if (!rows) throw new Error('ノードのデータが見つかりません');
      setPicked({ rows, label: f.name });
    } catch (e) {
      setError(`読み込めませんでした: ${e instanceof Error ? e.message : '形式が違います'}`);
    }
  };

  const pickServer = async (b: ServerBackup) => {
    setError('');
    const { data, error: err } = await supabase.from('desk_backups').select('nodes').eq('id', b.id).single();
    const rows = validate(data?.nodes);
    if (err || !rows) setError('このバックアップを読み込めませんでした');
    else setPicked({ rows, label: `サーバー ${when(b.taken_at)}` });
  };

  // 取り込み前の見込み（追加される件数・重複で飛ばす件数）
  const ids = new Set(currentNodes.map((n) => n.id));
  const contents = new Set(currentNodes.map((n) => n.content.trim()));
  const plan = picked
    ? {
        total: picked.rows.length,
        sameId: picked.rows.filter((r) => ids.has(r.id)).length,
        sameText: picked.rows.filter((r) => !ids.has(r.id) && contents.has(r.content.trim())).length,
        add: picked.rows.filter((r) => !ids.has(r.id) && !contents.has(r.content.trim())).length,
      }
    : null;

  const btn = 'border border-[#00f0ff]/50 text-[#00f0ff] px-3 py-1 rounded-full text-[11px] hover:bg-[#00f0ff]/20 disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onMouseDown={onClose} onTouchStart={onClose}>
      <div
        className="w-full max-w-2xl bg-[#0a1128] border border-[#00f0ff] rounded-t-2xl p-4 flex flex-col gap-3 max-h-[85vh] overflow-y-auto select-text"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center">
          <span className="text-xs font-bold text-[#00f0ff] tracking-widest">🛟 BACKUP // 統合して復元</span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xs px-2 py-0.5">
            [ 閉じる ✕ ]
          </button>
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          今あるノードは<b className="text-slate-200">変更も削除もしません</b>。バックアップにあって今は無いノードだけを追加します（同じ内容のものは重複させません）。
        </p>

        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <button type="button" className={btn} onClick={() => fileRef.current?.click()}>
            📂 JSONファイルを選ぶ
          </button>
        </div>

        {error && <div className="text-[11px] text-rose-300">⚠ {error}</div>}

        {picked && plan && (
          <div className="border border-yellow-300/50 bg-yellow-950/20 rounded-xl p-3 text-[11px] text-yellow-100 flex flex-col gap-2">
            <div>
              「{picked.label}」: 全{plan.total}件のうち
              <b className="text-white"> {plan.add}件を追加</b>、同じID {plan.sameId}件・同じ内容 {plan.sameText}件はそのまま（変更しません）
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || plan.add === 0}
                className="bg-[#00f0ff] text-[#030712] px-4 py-1.5 rounded-xl text-xs font-extrabold disabled:opacity-40"
                onClick={async () => {
                  setBusy(true);
                  await onMerge(picked.rows, picked.label);
                  setBusy(false);
                  onClose();
                }}
              >
                {busy ? '統合中…' : `✔ ${plan.add}件を統合する`}
              </button>
              <button type="button" className={btn} onClick={() => setPicked(null)}>
                やめる
              </button>
            </div>
          </div>
        )}

        <div className="text-[11px] text-slate-300 font-bold mt-1">自動バックアップ（1時間ごと）</div>
        <div className="flex flex-col gap-1.5">
          {serverList.length === 0 && localList.length === 0 && <span className="text-[10px] text-slate-500">まだバックアップがありません（開いてから約1時間ごとに自動で保存されます）</span>}
          {serverList.map((b) => (
            <div key={b.id} className="flex items-center justify-between text-[11px] border border-[#00f0ff]/20 rounded-lg px-3 py-1.5">
              <span>☁ サーバー {when(b.taken_at)}</span>
              <button type="button" className={btn} onClick={() => pickServer(b)}>
                選ぶ
              </button>
            </div>
          ))}
          {localList.map((b) => (
            <div key={b.t} className="flex items-center justify-between text-[11px] border border-[#00f0ff]/20 rounded-lg px-3 py-1.5">
              <span>
                💾 この端末 {when(b.t)}（{b.nodes.length}件）
              </span>
              <button type="button" className={btn} onClick={() => setPicked({ rows: b.nodes, label: `この端末 ${when(b.t)}` })}>
                選ぶ
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
