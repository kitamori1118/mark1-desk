import type { DeskNode, NodeFilter, TargetSelector, ToolContext } from './types';

/** 日付の判定・グルーピングに使うタイムゾーン */
export const DESK_TZ = 'Asia/Tokyo';
const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: DESK_TZ }); // → YYYY-MM-DD

export function toDay(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? '' : dayFmt.format(d);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 期限(YYYY-MM-DD)までの日数。今日=0、過ぎていれば負。解釈できなければ NaN */
export function daysUntil(due: string, now: Date): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${toDay(now)}T00:00:00Z`)) / 86_400_000);
}

export const dueOf = (n: DeskNode): string => (typeof n.metadata?.due === 'string' ? n.metadata.due : '');
export const isArchived = (n: DeskNode): boolean => !!n.metadata?.archived;
const norm = (s: string) => s.toLowerCase();

/** タグ未設定のノードは category をタグ代わりに扱う（既存の挙動を踏襲） */
export function nodeTags(n: DeskNode): string[] {
  const t = n.metadata?.tags;
  return Array.isArray(t) && t.length ? t.map(String) : [n.category];
}

export function matchesFilter(n: DeskNode, f: NodeFilter, now: Date): boolean {
  if (f.tags?.length) {
    const tags = nodeTags(n).map(norm);
    if (!f.tags.some((t) => tags.includes(norm(t)))) return false;
  }
  if (f.department && norm(n.category) !== norm(f.department)) return false;
  if (f.status && n.status !== f.status) return false;
  if (f.color && n.color !== f.color) return false;
  if (f.text && !norm(n.content).includes(norm(f.text))) return false;

  const meta = n.metadata ?? {};
  if (f.stage && meta.stage !== f.stage) return false;
  if (f.pinned != null && !!meta.pinned !== f.pinned) return false;
  const due = dueOf(n);
  if (f.noDue && due) return false;
  if (f.overdue || f.dueWithinDays != null) {
    const left = due ? daysUntil(due, now) : NaN;
    if (Number.isNaN(left)) return false;
    if (f.overdue ? left >= 0 : left > (f.dueWithinDays as number)) return false;
  }

  const createdMs = new Date(n.created_at).getTime();
  if (f.createdWithinDays != null && !Number.isNaN(createdMs)) {
    if (createdMs < now.getTime() - f.createdWithinDays * 86_400_000) return false;
  }
  const day = toDay(n.created_at);
  if (f.createdAfter && DAY_RE.test(f.createdAfter) && day && day < f.createdAfter) return false;
  if (f.createdBefore && DAY_RE.test(f.createdBefore) && day && day > f.createdBefore) return false;
  return true;
}

function hasAnyCondition(f?: NodeFilter | null): f is NodeFilter {
  if (!f) return false;
  return Object.values(f).some(
    (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
  );
}

/**
 * セレクターを実ノードに解決する。
 * - ids があればその順序を保ったまま採用（存在しないIDは捨てる）
 * - filter があれば ids / fromPrevious / 全ノードに対して AND で絞り込む
 * - どれも無ければ all=true か defaultTarget に従う（「うっかり全件更新」を防ぐ）
 */
export function resolveTargets(
  ctx: ToolContext,
  sel: TargetSelector | null | undefined,
  defaultTarget: 'all' | 'none'
): DeskNode[] {
  const s = sel ?? {};
  const byId = new Map(ctx.nodes.map((n) => [n.id, n] as const));
  // 既定ではアーカイブ済みを除外。filter.archived=true のときだけアーカイブ済みが対象
  const wantArchived = s.filter?.archived === true;
  const base = ctx.nodes.filter((n) => isArchived(n) === wantArchived);
  let pool: DeskNode[] | null = null;

  if (s.ids?.length) {
    const seen = new Set<string>();
    pool = [];
    for (const raw of s.ids) {
      const real = ctx.realId(raw);
      const n = real ? byId.get(real) : undefined;
      if (n && !seen.has(n.id)) {
        seen.add(n.id);
        pool.push(n);
      }
    }
  } else if (s.fromPrevious) {
    pool = ctx.lastTargetIds.map((id) => byId.get(id)).filter((n): n is DeskNode => !!n);
  }

  if (hasAnyCondition(s.filter)) {
    const filter = s.filter;
    pool = (pool ?? base).filter((n) => matchesFilter(n, filter, ctx.today));
  }

  if (pool) return pool;
  if (s.all) return [...base];
  return defaultTarget === 'all' ? [...base] : [];
}
