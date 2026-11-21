'use client';

import React, { useState } from 'react';

/** オーブをタップしたときに開く、手動編集シート（AIを使わず、すぐ直せる） */

export interface SheetNode {
  id: string;
  content: string;
  category: string;
  color: string;
  metadata?: { tags?: string[]; due?: string; stage?: string; pinned?: boolean; archived?: boolean };
}

export interface SheetPatch {
  content: string;
  color: string;
  category: string;
  tags: string[];
  due: string | null;
  stage: string | null;
  pinned: boolean;
}

const COLORS: [string, string][] = [
  ['cyan', '#00f0ff'],
  ['amber', '#fbbf24'],
  ['crimson', '#f43f5e'],
  ['emerald', '#34d399'],
];
const STAGES = ['未着手', '進行中', '完了'];

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

        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} className={`${field} resize-none`} />

        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="@タグ（最初のタグがカテゴリになります）"
          className={field}
        />

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[10px] text-slate-400">
            期限
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} />
          </label>
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

        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-400">色</span>
          {COLORS.map(([name, hex]) => (
            <button
              key={name}
              type="button"
              onClick={() => setColor(name)}
              style={{ backgroundColor: hex }}
              className={`w-7 h-7 rounded-full border-2 ${color === name ? 'border-white scale-110' : 'border-transparent opacity-60'}`}
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
