-- Mark1-desk：自動バックアップ用テーブル（任意）。Supabase の SQL Editor で1回だけ実行してください。
-- アプリを開いてから約1時間ごとに、全ノードのコピーが1行ずつ保存されます（古いものは自動で削除）。

create table if not exists desk_backups (
  id text primary key,                       -- 例: 2026-11-26-10（日付-時）
  taken_at timestamptz default timezone('utc'::text, now()),
  nodes jsonb not null
);

alter table desk_backups enable row level security;
drop policy if exists "auth all" on desk_backups;
create policy "auth all" on desk_backups for all to authenticated using (true) with check (true);
