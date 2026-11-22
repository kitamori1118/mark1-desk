import type { DeskNode } from './types';
import { DESK_TZ, daysUntil, dueOf, isArchived, nodeTags, toDay, toTime } from './selector';

/** AIを使わずに作る状況レポート（概況・件数）。report ツールにそのまま渡す文章 */

const short = (s: string, n = 16) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export function briefingText(nodes: DeskNode[], now: Date): string {
  const live = nodes.filter((n) => !isArchived(n));
  const archived = nodes.length - live.length;
  const today = toDay(now);
  const wd = new Intl.DateTimeFormat('ja-JP', { timeZone: DESK_TZ, weekday: 'short' }).format(now);
  const lines: string[] = [`■ 概況  ${md(today)}（${wd}）`];

  const pinned = live.filter((n) => n.metadata?.pinned).length;
  lines.push(`ノード ${live.length}件${archived ? `（アーカイブ ${archived}件）` : ''}${pinned ? ` ／ ピン ${pinned}件` : ''}`);

  const stages = new Map<string, number>();
  live.forEach((n) => {
    const st = (n.metadata?.stage as string) || '';
    if (st) stages.set(st, (stages.get(st) ?? 0) + 1);
  });
  if (stages.size) {
    const order = ['未着手', '進行中', '完了'];
    const parts = [...stages.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99)).map(([k, v]) => `${k} ${v}`);
    lines.push(`ステージ: ${parts.join('・')}（未設定 ${live.length - [...stages.values()].reduce((a, b) => a + b, 0)}）`);
  }

  const due = live
    .filter((n) => dueOf(n) && n.metadata?.stage !== '完了')
    .map((n) => ({ n, left: daysUntil(dueOf(n), now) }))
    .filter((x) => !Number.isNaN(x.left))
    .sort((a, b) => a.left - b.left);
  const over = due.filter((x) => x.left < 0);
  const soon = due.filter((x) => x.left >= 0 && x.left <= 3);
  if (over.length) {
    lines.push(`⚠ 期限超過 ${over.length}件`);
    over.slice(0, 5).forEach((x) => lines.push(`  ・「${short(x.n.content)}」 ${md(dueOf(x.n))}（${-x.left}日超過）`));
  }
  if (soon.length) {
    lines.push(`📅 3日以内 ${soon.length}件`);
    soon.slice(0, 5).forEach((x) => lines.push(`  ・「${short(x.n.content)}」 ${md(dueOf(x.n))}（${x.left === 0 ? '今日' : `あと${x.left}日`}）`));
  }
  if (!over.length && !soon.length) lines.push('期限が迫っているものはありません');

  const todays = live.filter((n) => toDay(n.created_at) === today).sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (todays.length) lines.push(`今日の記入 ${todays.length}件（最新 ${toTime(todays[0].created_at)}「${short(todays[0].content, 12)}」）`);

  const cats = new Map<string, number>();
  live.forEach((n) => nodeTags(n).slice(0, 1).forEach((t) => cats.set(t, (cats.get(t) ?? 0) + 1)));
  const top = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) lines.push(`カテゴリ: ${top.map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  return lines.join('\n');
}

export function countText(label: string, matched: DeskNode[], total: number): string {
  const lines = [`■ ${label}: ${matched.length}件（全${total}件中）`];
  matched.slice(0, 8).forEach((n) => lines.push(`  ・「${short(n.content, 20)}」`));
  if (matched.length > 8) lines.push(`  …ほか${matched.length - 8}件`);
  return lines.join('\n');
}
