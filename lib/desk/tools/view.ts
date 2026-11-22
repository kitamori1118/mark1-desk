import { z } from 'zod';
import { defineTool } from '../types';
import type { DeskNode, ToolContext, ViewDirective, ViewGroup } from '../types';
import { dueOf, hourOf, nodeTags, toDay, toTime } from '../selector';

/*
 * 表示系ツールは DB を変更しない。「どのノードを・どの順で・どうまとめて並べるか」を
 * ViewDirective としてクライアントに返し、座標は lib/desk/layoutPositions.ts が計算する。
 * レイアウト系は1回の指令につき1つだけ有効（先に実行されたものが優先）。
 */

const sortKeyZ = z.enum(['created_at', 'updated', 'time_of_day', 'due', 'category', 'color', 'status', 'length', 'custom']);
type SortKey = z.infer<typeof sortKeyZ>;
const orderZ = z.enum(['asc', 'desc']);

const time = (s?: string) => {
  const t = new Date(s ?? '').getTime();
  return Number.isNaN(t) ? 0 : t;
};
const isPinned = (n: DeskNode) => !!n.metadata?.pinned;
/** ピン留めを先頭へ（元の順序は保つ） */
const pinFirst = (nodes: DeskNode[]) => [...nodes.filter(isPinned), ...nodes.filter((n) => !isPinned(n))];
const STAGE_ORDER = ['アイデア', '未着手', '進行中', '完了'];

function sortNodes(nodes: DeskNode[], by: SortKey, order: 'asc' | 'desc'): DeskNode[] {
  // custom = AIが target.ids に並べた順をそのまま使う
  if (by === 'custom') return order === 'desc' ? [...nodes].reverse() : [...nodes];

  const cmp: Record<Exclude<SortKey, 'custom'>, (a: DeskNode, b: DeskNode) => number> = {
    created_at: (a, b) => time(a.created_at) - time(b.created_at),
    updated: (a, b) => time(a.metadata?.editedAt ?? a.created_at) - time(b.metadata?.editedAt ?? b.created_at),
    time_of_day: (a, b) => toTime(a.created_at).localeCompare(toTime(b.created_at)), // 日付を無視して、記入した時刻の早い順
    due: (a, b) => (dueOf(a) || '9999-99-99').localeCompare(dueOf(b) || '9999-99-99'),
    category: (a, b) => a.category.localeCompare(b.category, 'ja'),
    color: (a, b) => a.color.localeCompare(b.color),
    status: (a, b) => a.status.localeCompare(b.status),
    length: (a, b) => a.content.length - b.content.length,
  };
  const sorted = [...nodes].sort(cmp[by]);
  return order === 'desc' ? sorted.reverse() : sorted;
}

function hiddenOf(ctx: ToolContext, targets: DeskNode[], hideOthers?: boolean | null): string[] {
  if (hideOthers === false) return [];
  const shown = new Set(targets.map((n) => n.id));
  return ctx.nodes.filter((n) => !shown.has(n.id)).map((n) => n.id);
}

function commitView(ctx: ToolContext, view: ViewDirective, message: string): string {
  if (ctx.view) return `${message}（スキップ：レイアウト系は1回の指令に1つだけ）`;
  ctx.view = view;
  return message;
}

/* ------------------------------------------------------------------ */
/* arrange_view：一覧／グリッド＋並び順                                  */
/* ------------------------------------------------------------------ */

export const arrangeView = defineTool({
  name: 'arrange_view',
  phase: 80,
  description:
    '対象ノードを縦一覧またはグリッドに整列して表示し、並び順も指定できる。「絞り込んだものを一覧にして」「〇〇順に並べて」「最新5件」「記入した時間順」に使う。対象外のノードは隠す／薄くする',
  argsHint:
    "{ layout?: 'list'|'grid'（既定list）, sortBy?: 'created_at'（記入した日時順）|'updated'（編集した日時順）|'time_of_day'（日付を無視した記入時刻順）|'due'|'category'|'color'|'status'|'length'|'custom'（既定created_at）, order?: 'asc'|'desc', limit?: number（先頭からN件だけ表示）, hideOthers?: boolean（既定true）, title?: string }。重要度順・優先度順などAIの判断で並べるときは sortBy='custom' にして target.ids を希望の順に並べる",
  defaultTarget: 'all',
  argsSchema: z.object({
    layout: z.enum(['list', 'grid']).nullish(),
    sortBy: sortKeyZ.nullish(),
    order: orderZ.nullish(),
    limit: z.number().int().min(1).max(500).nullish(),
    hideOthers: z.boolean().nullish(),
    title: z.string().nullish(),
  }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'arrange_view: 対象ノードなし';
    const by = args.sortBy ?? 'created_at';
    const sorted0 = sortNodes(targets, by, args.order ?? 'asc');
    const sorted1 = by === 'custom' ? sorted0 : pinFirst(sorted0);
    const sorted = args.limit ? sorted1.slice(0, args.limit) : sorted1;
    return commitView(
      ctx,
      {
        layout: args.layout ?? 'list',
        title: args.title ?? undefined,
        order: sorted.map((n) => n.id),
        hiddenIds: hiddenOf(ctx, sorted, args.hideOthers),
      },
      `arrange_view: ${sorted.length}件を${args.layout === 'grid' ? 'グリッド' : '一覧'}表示`
    );
  },
});

/* ------------------------------------------------------------------ */

export const groupView = defineTool({
  name: 'group_view',
  phase: 81,
  description:
    'ノードをカテゴリ（部署）／色／状態／タグ／ステージごとのセクションにまとめて並べる。ステージ別はカンバン（横並びの列）になる。「部署ごとに」「カンバンで」「進行状況ごとに」に使う',
  argsHint:
    "{ by: 'category'|'color'|'status'|'tag'|'stage', layout?: 'columns'（縦に積む）|'kanban'（横の列。by=stageの既定）, sortBy?: 'created_at'|'due'|'category'|'color'|'status'|'length'（グループ内の並び。既定created_at）, hideOthers?: boolean（既定true）, title?: string }。ステージ未設定のノードは「(未設定)」の列になる。先に set_stage で付けておく",
  defaultTarget: 'all',
  argsSchema: z.object({
    by: z.enum(['category', 'color', 'status', 'tag', 'stage']),
    layout: z.enum(['columns', 'kanban']).nullish(),
    sortBy: sortKeyZ.nullish(),
    hideOthers: z.boolean().nullish(),
    title: z.string().nullish(),
  }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'group_view: 対象ノードなし';
    const buckets = new Map<string, DeskNode[]>();
    for (const n of targets) {
      const key =
        args.by === 'category'
          ? n.category
          : args.by === 'color'
          ? n.color
          : args.by === 'status'
          ? n.status
          : args.by === 'stage'
          ? (n.metadata?.stage as string) || '(未設定)'
          : nodeTags(n)[0] ?? '(タグなし)';
      buckets.set(key, [...(buckets.get(key) ?? []), n]);
    }
    const rank = (key: string) => {
      if (args.by !== 'stage') return 0;
      if (key === '(未設定)') return 1000;
      const i = STAGE_ORDER.indexOf(key);
      return i < 0 ? 100 : i;
    };
    const groups: ViewGroup[] = [...buckets.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].length - a[1].length)
      .map(([key, nodes]) => ({
        key,
        label: `${key}（${nodes.length}）`,
        ids: pinFirst(sortNodes(nodes, args.sortBy ?? 'created_at', 'asc')).map((n) => n.id),
      }));
    const layout = args.layout ?? (args.by === 'stage' ? 'kanban' : 'columns');

    return commitView(
      ctx,
      { layout, title: args.title ?? undefined, order: groups.flatMap((g) => g.ids), groups, hiddenIds: hiddenOf(ctx, targets, args.hideOthers) },
      `group_view: ${args.by}別に${groups.length}グループ（${layout === 'kanban' ? 'カンバン' : '縦'}）`
    );
  },
});

/* ------------------------------------------------------------------ */
/* cluster_view：AIが内容を読んで意味の近いものにまとめる                  */
/* ------------------------------------------------------------------ */

export const clusterView = defineTool({
  name: 'cluster_view',
  phase: 85,
  replayable: false,
  description:
    '内容を読んで、意味・テーマの近いノード同士をAIがグループ分けし、見出し付きで並べる。「テーマごとにまとめて」「似たもの同士で整理して」に使う（タグや部署では分けられない分類）',
  argsHint:
    "{ clusters: [{ label: テーマ名（短く）, ids: string[] }]（2〜8グループ。1ノードは1グループだけ）, layout?: 'columns'|'kanban', hideOthers?: boolean, title?: string }。どれにも入らないノードは「その他」になる",
  defaultTarget: 'all',
  argsSchema: z.object({
    clusters: z.array(z.object({ label: z.string(), ids: z.array(z.string()) })).min(1).max(12),
    layout: z.enum(['columns', 'kanban']).nullish(),
    hideOthers: z.boolean().nullish(),
    title: z.string().nullish(),
  }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'cluster_view: 対象ノードなし';
    const inTarget = new Set(targets.map((n) => n.id));
    const assigned = new Map<string, string>();
    for (const c of args.clusters) {
      for (const raw of c.ids) {
        const id = ctx.realId(raw);
        if (id && inTarget.has(id) && !assigned.has(id)) assigned.set(id, c.label.trim() || 'テーマ');
      }
    }
    const order = [...new Set(args.clusters.map((c) => c.label.trim() || 'テーマ'))];
    const groups: ViewGroup[] = [];
    for (const label of [...order, 'その他']) {
      const nodes = targets.filter((n) => (assigned.get(n.id) ?? 'その他') === label);
      if (nodes.length) groups.push({ key: label, label: `${label}（${nodes.length}）`, ids: pinFirst(nodes).map((n) => n.id) });
    }
    return commitView(
      ctx,
      {
        layout: args.layout ?? 'columns',
        title: args.title ?? undefined,
        order: groups.flatMap((g) => g.ids),
        groups,
        hiddenIds: hiddenOf(ctx, targets, args.hideOthers),
      },
      `cluster_view: ${groups.length}テーマに整理`
    );
  },
});

/* ------------------------------------------------------------------ */
/* matrix_view：2軸マトリクス（緊急度×重要度など）                         */
/* ------------------------------------------------------------------ */

export const matrixView = defineTool({
  name: 'matrix_view',
  phase: 86,
  replayable: false,
  description:
    '2つの軸（既定は緊急度×重要度）でAIが各ノードを評価し、4象限に仕分けて並べる。「優先度マトリクスにして」「やる/やらないを仕分けて」に使う',
  argsHint:
    '{ xLabel?: string（横軸。既定"緊急度"）, yLabel?: string（縦軸。既定"重要度"）, scores: [{ id, x: 0〜1, y: 0〜1 }]（全対象ノード分。1が「高い」）, hideOthers?: boolean, title?: string }',
  defaultTarget: 'all',
  argsSchema: z.object({
    xLabel: z.string().nullish(),
    yLabel: z.string().nullish(),
    scores: z.array(z.object({ id: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(1),
    hideOthers: z.boolean().nullish(),
    title: z.string().nullish(),
  }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'matrix_view: 対象ノードなし';
    const xl = args.xLabel?.trim() || '緊急度';
    const yl = args.yLabel?.trim() || '重要度';
    const score = new Map<string, { x: number; y: number }>();
    for (const s of args.scores) {
      const id = ctx.realId(s.id);
      if (id) score.set(id, { x: s.x, y: s.y });
    }
    const quads: Record<string, { label: string; nodes: DeskNode[] }> = {
      'q-tl': { label: `${yl}高 × ${xl}低`, nodes: [] },
      'q-tr': { label: `${yl}高 × ${xl}高`, nodes: [] },
      'q-bl': { label: `${yl}低 × ${xl}低`, nodes: [] },
      'q-br': { label: `${yl}低 × ${xl}高`, nodes: [] },
    };
    const unscored: DeskNode[] = [];
    for (const n of targets) {
      const sc = score.get(n.id);
      if (!sc) {
        unscored.push(n);
        continue;
      }
      quads[`q-${sc.y >= 0.5 ? 't' : 'b'}${sc.x >= 0.5 ? 'r' : 'l'}`].nodes.push(n);
    }
    const total = (id: string) => (score.get(id)?.x ?? 0) + (score.get(id)?.y ?? 0);
    const groups: ViewGroup[] = Object.entries(quads).map(([key, q]) => ({
      key,
      label: `${q.label}（${q.nodes.length}）`,
      ids: q.nodes.sort((a, b) => total(b.id) - total(a.id)).map((n) => n.id),
    }));
    if (unscored.length) groups.push({ key: 'q-none', label: `未評価（${unscored.length}）`, ids: unscored.map((n) => n.id) });

    return commitView(
      ctx,
      {
        layout: 'matrix',
        title: args.title ?? `${yl} × ${xl}`,
        order: groups.flatMap((g) => g.ids),
        groups,
        hiddenIds: hiddenOf(ctx, targets, args.hideOthers),
      },
      `matrix_view: ${yl}×${xl}で${targets.length}件を仕分け`
    );
  },
});

/* ------------------------------------------------------------------ */
/* timeline_view：時期ごと（日／週／月）                                 */
/* ------------------------------------------------------------------ */

function bucketOf(day: string, bucket: 'day' | 'week' | 'month'): { key: string; label: string } {
  if (bucket === 'month') return { key: day.slice(0, 7), label: `${day.slice(0, 4)}年${Number(day.slice(5, 7))}月` };
  if (bucket === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 月曜始まり
    const start = d.toISOString().slice(0, 10);
    return { key: start, label: `${Number(start.slice(5, 7))}/${Number(start.slice(8, 10))}〜の週` };
  }
  return { key: day, label: day };
}

/** 時間帯（日付は無視して、記入した時刻だけで分ける） */
const DAYPARTS: { name: string; from: number; to: number }[] = [
  { name: '深夜', from: 0, to: 5 },
  { name: '朝', from: 5, to: 9 },
  { name: '午前', from: 9, to: 12 },
  { name: '午後', from: 12, to: 17 },
  { name: '夕方', from: 17, to: 20 },
  { name: '夜', from: 20, to: 24 },
];

export const timelineView = defineTool({
  name: 'timeline_view',
  phase: 82,
  description:
    'ノードを記入した日時（または編集日時・期限）の時期ごとに区切って時系列に並べる。日・週・月・時間（1時間ごと）・時間帯（朝/午前/午後/夕方/夜）に対応。「時期ごとに」「時間別に」「時間帯ごとに」「古い順に」「期限順に」に使う',
  argsHint:
    "{ by?: 'created_at'（記入日時）|'updated'（編集日時）|'due'（期限）（既定created_at）, bucket?: 'day'|'week'|'month'|'hour'|'daypart'（既定week。hour=1時間ごと / daypart=朝・午前・午後・夕方・夜などの時間帯。hour と daypart は due では使えない）, order?: 'asc'|'desc'（既定asc）, hideOthers?: boolean（既定true）, title?: string }。期限が未設定のノードは「期限なし」にまとまる。期限を使うなら先に auto_tag の assignments か set_due で期限を付ける",
  defaultTarget: 'all',
  argsSchema: z.object({
    by: z.enum(['created_at', 'updated', 'due']).nullish(),
    bucket: z.enum(['day', 'week', 'month', 'hour', 'daypart']).nullish(),
    order: orderZ.nullish(),
    hideOthers: z.boolean().nullish(),
    title: z.string().nullish(),
  }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'timeline_view: 対象ノードなし';
    const by = args.by ?? 'created_at';
    let bucket = args.bucket ?? 'week';
    if (by === 'due' && (bucket === 'hour' || bucket === 'daypart')) bucket = 'day';
    const order = args.order ?? 'asc';

    const NONE = '~none';
    const stampOf = (n: DeskNode) => (by === 'updated' ? (n.metadata?.editedAt as string) || n.created_at : n.created_at);
    const buckets = new Map<string, { label: string; nodes: DeskNode[] }>();
    for (const n of targets) {
      let b: { key: string; label: string };
      if (by === 'due') {
        const day = dueOf(n);
        b = day ? bucketOf(day, bucket as 'day' | 'week' | 'month') : { key: NONE, label: '期限なし' };
      } else if (bucket === 'hour') {
        const day = toDay(stampOf(n));
        const h = hourOf(stampOf(n));
        b = day && h >= 0 ? { key: `${day} ${String(h).padStart(2, '0')}`, label: `${day.slice(5).replace('-', '/')} ${h}時台` } : { key: NONE, label: '日時なし' };
      } else if (bucket === 'daypart') {
        const h = hourOf(stampOf(n));
        const idx = DAYPARTS.findIndex((p) => h >= p.from && h < p.to);
        b = idx >= 0 ? { key: String(idx), label: `${DAYPARTS[idx].name}（${DAYPARTS[idx].from}〜${DAYPARTS[idx].to}時）` } : { key: NONE, label: '日時なし' };
      } else {
        const day = toDay(stampOf(n));
        b = day ? bucketOf(day, bucket) : { key: NONE, label: '日時なし' };
      }
      const entry = buckets.get(b.key) ?? { label: b.label, nodes: [] };
      entry.nodes.push(n);
      buckets.set(b.key, entry);
    }

    const keys = [...buckets.keys()].filter((k) => k !== NONE).sort();
    if (order === 'desc') keys.reverse();
    if (buckets.has(NONE)) keys.push(NONE);

    const sortBy = by === 'due' ? 'due' : by === 'updated' ? 'updated' : 'created_at';
    const groups: ViewGroup[] = keys.map((key) => {
      const { label, nodes } = buckets.get(key)!;
      return { key, label: `${label}（${nodes.length}）`, ids: sortNodes(nodes, sortBy, order).map((n) => n.id) };
    });

    const unit: Record<string, string> = { day: '日', week: '週', month: '月', hour: '時間', daypart: '時間帯' };
    const what = by === 'due' ? '期限' : by === 'updated' ? '編集日時' : '記入日時';
    return commitView(
      ctx,
      {
        layout: 'timeline',
        title: args.title ?? undefined,
        order: groups.flatMap((g) => g.ids),
        groups,
        hiddenIds: hiddenOf(ctx, targets, args.hideOthers),
      },
      `timeline_view: ${what}の${unit[bucket]}単位で${groups.length}区間`
    );
  },
});

/* ------------------------------------------------------------------ */
/* orbit_view：重力・軌道レイアウト（テーマとの関連度で同心円）            */
/* ------------------------------------------------------------------ */

export const orbitView = defineTool({
  name: 'orbit_view',
  phase: 83,
  description: '指定した最優先テーマ／ノードを中心に置き、関連度の高いノードほど内側の軌道に同心円状に配置する（重力レイアウト）',
  argsHint:
    '{ centerId?: string（中心にするノード）, scores: [{ id, score: 0〜1 }]（中心テーマとの関連度。全対象ノード分を出す）, title?: string }',
  defaultTarget: 'all',
  argsSchema: z.object({
    centerId: z.string().nullish(),
    scores: z.array(z.object({ id: z.string(), score: z.number().min(0).max(1) })).nullish(),
    title: z.string().nullish(),
  }),
  async run(ctx, targets, args) {
    if (!targets.length) return 'orbit_view: 対象ノードなし';
    const score = new Map<string, number>();
    for (const s of args.scores ?? []) {
      const id = ctx.realId(s.id);
      if (id) score.set(id, s.score);
    }
    const center = args.centerId ? ctx.realId(args.centerId) : null;
    const sorted = [...targets].sort(
      (a, b) =>
        (b.id === center ? 1 : 0) - (a.id === center ? 1 : 0) || (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)
    );

    const band = (n: DeskNode) => {
      if (n.id === center) return 0;
      const s = score.get(n.id) ?? 0;
      return s >= 0.7 ? 0 : s >= 0.4 ? 1 : 2;
    };
    const labels = ['最優先', '関連', '周辺'];
    const groups: ViewGroup[] = [0, 1, 2]
      .map((b) => ({ key: `ring-${b}`, label: labels[b], ids: sorted.filter((n) => band(n) === b).map((n) => n.id) }))
      .filter((g) => g.ids.length);

    return commitView(
      ctx,
      {
        layout: 'orbit',
        title: args.title ?? undefined,
        order: sorted.map((n) => n.id),
        groups,
        centerId: center && sorted.some((n) => n.id === center) ? center : sorted[0].id,
        hiddenIds: hiddenOf(ctx, targets, true),
      },
      `orbit_view: ${sorted.length}件を軌道配置`
    );
  },
});

/* ------------------------------------------------------------------ */
/* reset_view：自由配置に戻す                                           */
/* ------------------------------------------------------------------ */

export const resetView = defineTool({
  name: 'reset_view',
  phase: 84,
  description: '一覧・時系列・軌道などの整列表示をやめて、元の自由配置に戻し、隠していたノードも全部表示する',
  argsHint: '{}',
  defaultTarget: 'none',
  argsSchema: z.object({}),
  async run(ctx) {
    return commitView(ctx, { layout: 'free', order: [], hiddenIds: [] }, 'reset_view: 自由配置に戻します');
  },
});
