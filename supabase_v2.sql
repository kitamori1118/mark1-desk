-- Mark1-desk v3：履歴(Undo)とマクロ用のテーブル。Supabase の SQL Editor で1回だけ実行してください。

create table if not exists desk_ops (
  id uuid primary key default gen_random_uuid(),
  command text,
  before jsonb not null,
  created_at timestamptz default timezone('utc'::text, now())
);

create table if not exists desk_macros (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  command text,
  plan jsonb not null,
  created_at timestamptz default timezone('utc'::text, now())
);

alter table desk_ops enable row level security;
alter table desk_macros enable row level security;

-- ↓ 既存の stark_nodes 等と同じ方針のポリシーに合わせてください（下は「個人利用・誰でも読み書き可」の例）。
--   anon key はブラウザに出るため、公開URLで使うなら Supabase Auth で自分だけに絞るのがおすすめです。
drop policy if exists "desk_ops all" on desk_ops;
drop policy if exists "desk_macros all" on desk_macros;
create policy "desk_ops all" on desk_ops for all using (true) with check (true);
create policy "desk_macros all" on desk_macros for all using (true) with check (true);
