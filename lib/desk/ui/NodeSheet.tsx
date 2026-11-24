'use client';

import React, { useState } from 'react';

/** オーブをタップしたときに開く、手動編集シート（AIを使わず、すぐ直せる） */

export interface SheetNode {
  id: string;
  created_at?: string;
  content: string;
  category: string;
  color: string;
  metadata?: { tags?: string[]; due?: string; stage?: string; pinned?: boolean; archived?: boolean; editedAt?: string; title?: string };
}

export interface SheetPatch {
  content: string;
  color: string;
  category: string;
  tags: string[];
  due: string | null;
  stage: string | null;
  pinned: boolean;
  title: string | null;
}

const COLORS: [string, string][] = [
  ['cyan', '#00f0ff'],
  ['blue', '#3b82f6'],
  ['violet', '#a78bfa'],
  ['pink', '#f472b6'],
  ['crimson', '#f43f5e'],
  ['orange', '#fb923c'],
  ['amber', '#fbbf24'],
  ['lime', '#a3e635'],
  ['emerald', '#34d399'],
  ['slate', '#94a3b8'],
];
const STAGES = ['未着手', '進行中', '完了'];

const fmtJst = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/** 端末のローカル日付で YYYY-MM-DD（ボタン操作の中でだけ呼ぶ） */
const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftDay = (base: string, n: number) => {
  const d = base ? new Date(`${base}T00:00:00`) : new Date();
  d.setDate(d.getDate() + n);
  return ymdLocal(d);
};

const field =
  'bg-[#030712] border border-[#00f0ff]/40 rounded-xl px-3 py-2 text-xs md:text-sm text-slate-100 focus:outline-none focus:border-[#00f0ff]';

export default function NodeSheet({
  node,
  onClose,
  onSave,
  onToggleArchive,
  onDelete,
}: {
  node: SheetNode;
  onClose: () => void;
  onSave: (patch: SheetPatch) => Promise<void>;
  onToggleArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const m = node.metadata ?? {};
  const [title, setTitle] = useState(m.title ?? '');
  const [content, setContent] = useState(node.content);
  const [tags, setTags] = useState((m.tags && m.tags.length ? m.tags : [node.category]).map((t) => `@${t}`).join(' '));
  const [due, setDue] = useState(m.due ?? '');
  const [stage, setStage] = useState(m.stage ?? '');
  const [color, setColor] = useState(node.color);
  const [pinned, setPinned] = useState(!!m.pinned);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const list: string[] = [...new Set<string>(String(tags).split(/[\s,、]+/).map((t) => t.replace(/^@/, '').trim()).filter(Boolean))];
    setBusy(true);
    await onSave({
      content: content.trim() || node.content,
      color,
      category: list[0] ?? node.category,
      tags: list.length ? list : [node.category],
      due: due || null,
      stage: stage || null,
      pinned,
      title: title.trim() || null,
    });
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onMouseDown={onClose} onTouchStart={onClose}>
      <div
        className="w-full max-w-2xl bg-[#0a1128] border border-[#00f0ff] rounded-t-2xl p-4 flex flex-col gap-3 shadow-[0_0_30px_rgba(0,240,255,0.3)] max-h-[85vh] overflow-y-auto select-text"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center">
          <span className="text-xs font-bold text-[#00f0ff] tracking-widest">✎ ORB EDITOR</span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xs px-2 py-0.5">
            [ 閉じる ✕ ]
          </button>
        </div>

        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="題名（任意・短い見出し）" className={`${field} font-bold`} />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} className={`${field} resize-none`} />

        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="@タグ（最初のタグがカテゴリになります）"
          className={field}
        />

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 text-[10px] text-slate-400">
            <label className="flex flex-col gap-1">
              期限
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} />
            </label>
            <div className="flex flex-wrap gap-1">
              {[
                ['今日', () => ymdLocal(new Date())],
                ['明日', () => shiftDay(ymdLocal(new Date()), 1)],
                ['来週', () => shiftDay(ymdLocal(new Date()), 7)],
                ['−1日', () => shiftDay(due, -1)],
                ['+1日', () => shiftDay(due, 1)],
                ['+1週', () => shiftDay(due, 7)],
              ].map(([label, fn]) => (
                <button
                  key={label as string}
                  type="button"
                  onClick={() => setDue((fn as () => string)())}
                  className="px-2 py-0.5 rounded-full border border-[#00f0ff]/40 text-[#00f0ff] hover:bg-[#00f0ff]/15 text-[10px]"
                >
                  {label as string}
                </button>
              ))}
              <button type="button" onClick={() => setDue('')} className="px-2 py-0.5 rounded-full border border-rose-400/50 text-rose-300 hover:bg-rose-500/15 text-[10px]">
                クリア
              </button>
            </div>
          </div>
          <label className="flex flex-col gap-1 text-[10px] text-slate-400">
            ステージ
            <select value={stage} onChange={(e) => setStage(e.target.value)} className={field}>
              <option value="">（なし）</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="text-[10px] text-slate-500 leading-relaxed">
          {node.created_at && <div>🕒 記入: {fmtJst(node.created_at)}</div>}
          {m.editedAt && <div>✎ 編集: {fmtJst(m.editedAt)}</div>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-slate-400">色</span>
          {COLORS.map(([name, hex]) => (
            <button
              key={name}
              type="button"
              onClick={() => setColor(name)}
              style={{ backgroundColor: hex }}
              className={`w-6 h-6 rounded-full border-2 ${color === name ? 'border-white scale-110' : 'border-transparent opacity-60'}`}
              aria-label={name}
            />
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-200">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 📌 ピン留め
          </label>
        </div>

        <div className="flex flex-wrap gap-2 justify-between pt-1">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onToggleArchive}
              className="border border-[#00f0ff]/40 text-[#00f0ff] px-3 py-1.5 rounded-lg text-xs hover:bg-[#00f0ff]/20"
            >
              {node.metadata?.archived ? '🗄 復元' : '🗄 アーカイブ'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('このオーブを削除しますか？')) onDelete();
              }}
              className="border border-rose-500/50 text-rose-300 px-3 py-1.5 rounded-lg text-xs hover:bg-rose-500/20"
            >
              削除
            </button>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="bg-[#00f0ff] text-[#030712] px-6 py-2 rounded-xl text-xs font-extrabold tracking-wider hover:bg-[#00f0ff]/80 active:scale-95 transition-all disabled:opacity-50"
          >
            {busy ? 'SAVING...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
