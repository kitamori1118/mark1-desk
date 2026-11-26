-- Mark1-desk：バックアップ（mark1-desk-2026-11-26.json）を「統合」して復元する
-- Supabase の SQL Editor に貼り付けて、1回だけ実行してください。
--   ・今あるノードは一切変更・削除しません（上書きしません）
--   ・同じID、または本文がまったく同じノードが今あれば、そのノードは追加しません（重複させない）
--   ・足りないノードだけを、元の作成日時のまま追加します
-- 実行後、アプリを再読み込みしてください。

with backup(id, content, category, color, status, metadata, created_at) as (
  values
  ('bf6a5bae-5fe7-4729-96de-519bc8614f5e', 'タスクに施行の仮説を織り込む', 'アイデア', 'cyan', 'normal', '{"tags": ["アイデア"], "opacity": 1, "commentMode": false}', '2026-11-24T14:59:12.649963+00:00'),
  ('e5be1bd8-9a15-4349-b923-ba0a8ff4b87f', 'タスクはやることがないときにやる？', 'アイデア', 'cyan', 'normal', '{"tags": ["アイデア"], "links": ["bf6a5bae-5fe7-4729-96de-519bc8614f5e"], "opacity": 1, "commentMode": false}', '2026-11-24T14:58:47.993101+00:00'),
  ('e3b0b371-9bba-4538-9e88-e70bea28e991', 'Whoの典型的な特性を考える、仮説を立てる', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["e5be1bd8-9a15-4349-b923-ba0a8ff4b87f"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T14:38:48.020525+00:00'),
  ('30c7e07c-7ed6-4649-b263-9bae3581b3f8', 'whatの仮説をしっかりデータと比較する', 'アイデア', 'cyan', 'normal', '{"tags": ["アイデア", "マーケ"], "links": ["e3b0b371-9bba-4538-9e88-e70bea28e991"], "opacity": 1, "commentMode": false}', '2026-11-24T14:36:20.488694+00:00'),
  ('cccb31cf-78e5-4029-9a73-7a3125d29263', 'who whatの組み合わせの最大化▶︎データで探す', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["30c7e07c-7ed6-4649-b263-9bae3581b3f8"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T14:36:05.457336+00:00'),
  ('3a0e51d2-c058-46c0-9cec-1d9e30e68332', 'Whatイコール仮説', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["cccb31cf-78e5-4029-9a73-7a3125d29263"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T14:34:50.437032+00:00'),
  ('59c28d54-54d8-4aa5-96ef-5dcae6722fb1', 'Who whatまでマーケでやって施策を各部署に下ろす', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["3a0e51d2-c058-46c0-9cec-1d9e30e68332"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T14:34:08.842507+00:00'),
  ('f8f048d8-a627-4f9d-8ffb-79de0c1e7146', '顧客をベースに考える▶︎セグメントに分ける(どれくらいいる？データ)▶︎どのからどこに移動させたい▶︎このセグメントの人はどんな人(データ)(子供の例一人の時間が多い)(who)▶︎じゃあ寂しくないようには(What)特別なことなど▶︎じゃあipadがいいよね、何がいいよね(4P施策)▶︎who whatに対して価値を提供できてるか、適した政策かどうか逆算', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["59c28d54-54d8-4aa5-96ef-5dcae6722fb1"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T14:33:47.711925+00:00'),
  ('c0fbfca8-d1f5-4bf4-b379-3114d5bfe91d', '経営研究に一番繋がる', 'アイデア', 'cyan', 'normal', '{"tags": ["アイデア", "マーケ"], "links": ["f8f048d8-a627-4f9d-8ffb-79de0c1e7146"], "opacity": 1, "commentMode": false}', '2026-11-24T14:17:32.119232+00:00'),
  ('d08c2dc7-1880-4565-9d19-238b7ae5989e', '自社データだけじゃダメ、競合他社のデータも', 'アイデア', 'cyan', 'normal', '{"tags": ["アイデア", "マーケ"], "links": ["c0fbfca8-d1f5-4bf4-b379-3114d5bfe91d"], "opacity": 1, "commentMode": false}', '2026-11-24T14:15:36.732648+00:00'),
  ('d1bd0136-cd69-4cb2-a911-8bd444dcec9c', 'データを掘り下げて仮説を立てる', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["d08c2dc7-1880-4565-9d19-238b7ae5989e"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T14:12:07.176512+00:00'),
  ('861b8f90-8eab-473d-82b9-b81f2f3f6dc3', '教育、高め合う', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["d1bd0136-cd69-4cb2-a911-8bd444dcec9c"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T13:57:32.350844+00:00'),
  ('94bd98c0-7d7c-45ea-b3ec-06b89f7e48de', '9セグ', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["861b8f90-8eab-473d-82b9-b81f2f3f6dc3"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T13:57:10.479134+00:00'),
  ('08198257-ef06-407e-bdce-090e480dd0d2', '喜ばせるためのマーケティング', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["94bd98c0-7d7c-45ea-b3ec-06b89f7e48de"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T13:53:27.846652+00:00'),
  ('220d8595-ed93-414b-8aaf-fa9b440555ef', 'プレゼンする練習を行えるようにする', 'マーケ', 'violet', 'normal', '{"tags": ["マーケ", "アイデア"], "links": ["08198257-ef06-407e-bdce-090e480dd0d2"], "stack": "smwvgwj8d0", "opacity": 1, "commentMode": false}', '2026-11-24T13:52:06.056475+00:00'),
  ('de169d94-ab48-46ca-a683-b6ef2ba2eaa6', '各部署の進行計画とタスク表を照らし合わせる', 'タスク', 'amber', 'scanned', '{"due": "2026-11-26", "tags": ["タスク"], "stage": "進行中", "comment": "あと3日", "opacity": 1, "commentMode": true}', '2026-11-22T15:01:42.833947+00:00'),
  ('95c1bd27-a256-48d5-b7f2-a47ae8f796b1', '話すことまとめておく', 'タスク', 'cyan', 'normal', '{"tags": ["タスク"], "stack": "smwrl2og5", "opacity": 1, "commentMode": false}', '2026-11-21T08:11:36.491237+00:00'),
  ('4eca22d1-f8e4-4b9b-b378-314ebc46d342', '日程調整', 'タスク', 'cyan', 'scanned', '{"due": "2026-11-24", "tags": ["タスク"], "stack": "smwrl2og5", "comment": "あと1日", "opacity": 1, "commentMode": true}', '2026-11-21T08:11:05.11767+00:00'),
  ('b8ccdb68-0999-427e-95e3-cd108d2e17f3', '本間社長と顔合わせ', 'タスク', 'cyan', 'normal', '{"tags": ["タスク"], "stack": "smwrl2og5", "opacity": 1, "commentMode": false}', '2026-11-21T08:10:47.709305+00:00'),
  ('ad26e855-6de3-441b-be20-23ff962cfc37', '券売機を写真付きにする', '店舗運営', 'amber', 'normal', '{"tags": ["店舗運営", "アイデア"], "stack": "smwrl2rdh", "opacity": 1, "commentMode": false}', '2026-11-20T01:36:54.658805+00:00'),
  ('3c4f0a7c-2078-4c5b-8430-d54c196bcf59', '券売機にレール', 'アイデア', 'amber', 'normal', '{"tags": ["アイデア", "店舗運営"], "stack": "smwrl2rdh", "opacity": 1, "commentMode": false}', '2026-11-20T01:36:24.435598+00:00')
)
insert into public.stark_nodes (id, content, category, color, status, metadata, created_at)
select b.id::uuid, b.content, b.category, b.color, b.status, b.metadata::jsonb, b.created_at::timestamptz
from backup b
where not exists (
  select 1 from public.stark_nodes s
  where s.id = b.id::uuid or s.content = b.content
);

-- 追加された件数を確認（バックアップは 21 件）
select count(*) as nodes_now from public.stark_nodes;
