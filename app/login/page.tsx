'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

/** 自分専用のログイン画面。サインアップは用意していない（Supabase 側でも新規登録をオフにしておく） */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/');
    });
  }, [router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setMessage('認証に失敗しました。メールアドレスとパスワードを確認してください');
      setBusy(false);
      return;
    }
    router.replace('/');
  };

  return (
    <div className="min-h-screen bg-[#030712] text-[#00f0ff] font-mono flex items-center justify-center p-4 relative">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#00f0ff05_1px,transparent_1px),linear-gradient(to_bottom,#00f0ff05_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none" />
      <form
        onSubmit={handleLogin}
        className="relative w-full max-w-sm bg-[#0a1128]/95 border border-[#00f0ff]/60 rounded-2xl p-6 shadow-[0_0_30px_rgba(0,240,255,0.25)] flex flex-col gap-4"
      >
        <div>
          <h1 className="text-sm font-bold tracking-widest drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]">MARK1-DESK // ACCESS</h1>
          <p className="text-[10px] text-slate-400 mt-1">IDENTIFY YOURSELF, SIR.</p>
        </div>
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="メールアドレス"
          className="bg-[#030712] border border-[#00f0ff]/40 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#00f0ff]"
        />
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="パスワード"
          className="bg-[#030712] border border-[#00f0ff]/40 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#00f0ff]"
        />
        {message && <p className="text-[11px] text-rose-300">{message}</p>}
        <button
          type="submit"
          disabled={busy}
          className="bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] py-2.5 rounded-xl text-sm font-bold tracking-wider hover:bg-[#00f0ff]/30 active:scale-95 transition-all disabled:opacity-50"
        >
          {busy ? '...AUTH' : 'ACCESS'}
        </button>
      </form>
    </div>
  );
}
