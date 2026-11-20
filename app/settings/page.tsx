'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';

interface BrainMemory {
  id: string;
  title?: string;
  content: string;
  updated_at: string;
}

interface DeskTag {
  id: string;
  tag_name: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false); // ログイン確認が済むまで画面を出さない
  const [notice, setNotice] = useState(''); // 失敗したときのメッセージ

  const [memories, setMemories] = useState<BrainMemory[]>([]);
  const [tags, setTags] = useState<DeskTag[]>([]);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [newTag, setNewTag] = useState('');

  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    const { data: memData, error: memErr } = await supabase
      .from('brain_context')
      .select('*')
      .order('updated_at', { ascending: false });
    if (memErr) setNotice(`記憶の読み込みに失敗しました: ${memErr.message}`);
    else if (memData) setMemories(memData);

    const { data: tagData, error: tagErr } = await supabase
      .from('desk_tags')
      .select('*')
      .order('created_at', { ascending: true });
    if (tagErr) setNotice(`タグの読み込みに失敗しました: ${tagErr.message}`);
    else if (tagData) setTags(tagData);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace('/login');
        return;
      }
      setAuthed(true);
      fetchData();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') router.replace('/login');
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || loading) return;

    setLoading(true);
    setNotice('');
    const { error } = await supabase.from('brain_context').insert({
      title: title.trim() || 'Untitled Note',
      content: content.trim(),
    });

    if (error) {
      setNotice(`保存に失敗しました: ${error.message}`);
    } else {
      setTitle('');
      setContent('');
    }
    setLoading(false);
    fetchData();
  };

  // .select() で「実際に消えた行」を受け取る。RLS に DELETE の許可が無いと、エラーなしで0件になるため
  const handleDeleteMemory = async (id: string) => {
    const { data, error } = await supabase.from('brain_context').delete().eq('id', id).select('id');
    if (error) setNotice(`削除に失敗しました: ${error.message}`);
    else if (!data || data.length === 0) setNotice('削除できませんでした（Supabase の RLS に DELETE の許可が無い可能性）');
    else setNotice('');
    fetchData();
  };

  // 💡 タグの追加
  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTag = newTag.replace('@', '').trim();
    if (!cleanTag) return;

    const { error } = await supabase.from('desk_tags').insert({ tag_name: cleanTag });
    if (error) {
      setNotice(error.code === '23505' ? `タグ「${cleanTag}」は既にあります` : `タグの追加に失敗しました: ${error.message}`);
    } else {
      setNotice('');
      setNewTag('');
    }
    fetchData();
  };

  // 💡 タグの削除
  const handleDeleteTag = async (id: string) => {
    const { data, error } = await supabase.from('desk_tags').delete().eq('id', id).select('id');
    if (error) setNotice(`削除に失敗しました: ${error.message}`);
    else if (!data || data.length === 0) setNotice('削除できませんでした（Supabase の RLS に DELETE の許可が無い可能性）');
    else setNotice('');
    fetchData();
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#030712] text-[#00f0ff] font-mono flex items-center justify-center text-xs tracking-widest">
        AUTHENTICATING...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#030712] text-[#00f0ff] font-mono p-4 md:p-8 relative">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center border-b border-[#00f0ff33] pb-4 mb-6">
          <div>
            <h1 className="text-base md:text-xl font-bold tracking-widest text-[#00f0ff]">
              JARVIS // BRAIN VAULT & TAG MANAGER
            </h1>
            <p className="text-xs text-slate-400">コンテキストの蓄積 ＆ @タグ設定の管理</p>
          </div>
          <Link
            href="/"
            className="border border-[#00f0ff]/50 px-3 py-1.5 rounded-lg text-xs hover:bg-[#00f0ff]/20 transition-all"
          >
            ← DESKへ戻る
          </Link>
        </div>

        {notice && (
          <div className="flex justify-between items-start gap-3 bg-rose-950/40 border border-rose-400/60 text-rose-200 rounded-xl px-4 py-2.5 mb-6 text-xs">
            <span>⚠ {notice}</span>
            <button type="button" onClick={() => setNotice('')} className="shrink-0 text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
        )}

        {/* 💡 タグマネージャーセクション */}
        <div className="bg-[#0a1128]/95 border border-[#00f0ff]/40 rounded-xl p-4 mb-6">
          <h2 className="text-xs tracking-widest text-slate-300 font-bold mb-3">🏷️ クイック @タグ の管理（デスクの入力スロットに連動）</h2>

          <div className="flex flex-wrap gap-2 mb-4">
            {tags.map((t) => (
              <div key={t.id} className="flex items-center gap-1 bg-[#030712] border border-[#00f0ff]/40 text-[#00f0ff] px-3 py-1 rounded-full text-xs">
                <span>@{t.tag_name}</span>
                <button
                  onClick={() => handleDeleteTag(t.id)}
                  className="text-rose-400 hover:text-rose-300 ml-1 font-bold"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <form onSubmit={handleAddTag} className="flex gap-2">
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="新しいタグ名（例: 財務, 試作, 重要 など）..."
              className="flex-1 bg-[#030712] border border-[#00f0ff]/30 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#00f0ff]"
            />
            <button
              type="submit"
              className="bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] px-4 py-2 rounded-lg text-xs font-bold hover:bg-[#00f0ff]/30 transition-all"
            >
              タグを追加
            </button>
          </form>
        </div>

        {/* 自由記述記憶セクション */}
        <form onSubmit={handleAddMemory} className="bg-[#0a1128]/95 border border-[#00f0ff]/40 rounded-xl p-4 mb-6 flex flex-col gap-3">
          <h2 className="text-xs tracking-widest text-slate-300 font-bold">＋ 新しい記憶・コンテキストを放り込む</h2>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="タイトル（任意、例: サークルの現在の課題など）..."
            className="bg-[#030712] border border-[#00f0ff]/30 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#00f0ff]"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="フォーマットなしで自由に書き殴る..."
            rows={4}
            className="bg-[#030712] border border-[#00f0ff]/30 rounded-lg p-3 text-xs md:text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#00f0ff] resize-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="self-end bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] px-4 py-2 rounded-lg text-xs font-bold hover:bg-[#00f0ff]/30 transition-all"
          >
            {loading ? 'SAVING...' : 'VAULTに記憶させる'}
          </button>
        </form>

        <div className="flex flex-col gap-3">
          {memories.map((mem) => (
            <div key={mem.id} className="bg-[#0a1128]/70 border border-[#00f0ff]/20 rounded-xl p-4 relative">
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xs md:text-sm font-bold text-amber-300 tracking-wider">{mem.title}</h3>
                <button
                  onClick={() => handleDeleteMemory(mem.id)}
                  className="text-[10px] text-rose-400 hover:text-rose-300 border border-rose-500/30 px-2 py-0.5 rounded"
                >
                  削除
                </button>
              </div>
              <p className="text-xs md:text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{mem.content}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
