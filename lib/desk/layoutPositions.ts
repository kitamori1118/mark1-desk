import type { ViewDirective } from './types';

/*
 * クライアント側で使う純関数（DB・サーバー依存なし）。
 * ViewDirective（どの順で・どうまとめるか）を、画面幅に合わせたオーブ中心座標に変換する。
 * 常時シミュレーションは回さず、1回計算して transform でアニメさせる前提。
 */

export interface LayoutOptions {
  /** 表示領域の幅(px) */
  width: number;
  /** オーブの直径(px) 既定72 */
  orb?: number;
  /** オーブ間の隙間(px) 既定16 */
  gap?: number;
}

export interface LayoutResult {
  /** オーブ「中心」の座標 */
  positions: Record<string, { x: number; y: number }>;
  /** セクション見出しの左上座標（w があれば、その幅に収める） */
  labels: { key: string; label: string; x: number; y: number; w?: number }[];
  /** 配置全体の大きさ。表示領域より大きい場合は横／縦スクロールで見せる */
  size: { width: number; height: number };
}

export function computeViewPositions(view: ViewDirective, opt: LayoutOptions): LayoutResult | null {
  if (view.layout === 'free' || view.order.length === 0) return null;

  const orb = opt.orb ?? 72;
  const gap = opt.gap ?? 16;
  const pad = 24;
  const cell = orb + gap;
  const HEAD = 28; // セクション見出しの高さ
  const width = Math.max(opt.width, cell + pad * 2);
  const cols = Math.max(1, Math.floor((width - pad * 2 + gap) / cell));

  const positions: LayoutResult['positions'] = {};
  const labels: LayoutResult['labels'] = [];

  /** ids を、左端 left・幅 w の枠の中で y から折り返しながら中央寄せで並べ、次の y を返す */
  const flowAt = (ids: string[], left: number, w: number, y: number, perRow: number): number => {
    ids.forEach((id, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, ids.length - row * perRow);
      const rowWidth = inRow * cell - gap;
      const x0 = left + (w - rowWidth) / 2 + orb / 2;
      positions[id] = { x: x0 + (i % perRow) * cell, y: y + row * cell + orb / 2 };
    });
    return y + Math.ceil(ids.length / perRow) * cell;
  };
  const flow = (ids: string[], y: number, perRow: number) => flowAt(ids, 0, width, y, perRow);
  const done = (w: number, h: number): LayoutResult => ({ positions, labels, size: { width: w, height: h + pad } });

  if (view.layout === 'list') return done(width, flow(view.order, pad, 1));
  if (view.layout === 'grid') return done(width, flow(view.order, pad, cols));

  // スマホ幅でも崩れないよう、グループを縦に積むセクション方式
  if (view.layout === 'columns' || view.layout === 'timeline') {
    let y = pad;
    for (const g of view.groups ?? [{ key: 'all', label: '', ids: view.order }]) {
      labels.push({ key: g.key, label: g.label, x: pad, y: y + 10 });
      y = flow(g.ids, y + HEAD, cols) + gap;
    }
    return done(width, y);
  }

  // カンバン：グループを横の列にして、各列は縦に積む（横スクロール）
  if (view.layout === 'kanban') {
    const groups = view.groups ?? [{ key: 'all', label: '', ids: view.order }];
    const total = groups.length * cell + (groups.length - 1) * gap;
    const w2 = Math.max(width, total + pad * 2);
    const startX = (w2 - total) / 2;
    let bottom = pad + HEAD;
    groups.forEach((g, gi) => {
      const left = startX + gi * (cell + gap);
      labels.push({ key: g.key, label: g.label, x: left, y: pad + 10, w: cell });
      bottom = Math.max(bottom, flowAt(g.ids, left, cell, pad + HEAD, 1));
    });
    return done(w2, bottom);
  }

  // マトリクス：2×2の象限（tl tr / bl br）。象限以外のグループ（未評価）は下にセクションで並べる
  if (view.layout === 'matrix') {
    const byKey = new Map((view.groups ?? []).map((g) => [g.key, g] as const));
    const blockW = Math.max(cell, (width - pad * 2 - gap) / 2);
    const perRow = Math.max(1, Math.floor((blockW + gap) / cell));
    let y = pad;
    for (const row of [['q-tl', 'q-tr'], ['q-bl', 'q-br']]) {
      let rowEnd = y + HEAD + cell;
      row.forEach((key, ci) => {
        const g = byKey.get(key);
        const left = pad + ci * (blockW + gap);
        labels.push({ key, label: g?.label ?? '', x: left, y: y + 10, w: blockW });
        if (g?.ids.length) rowEnd = Math.max(rowEnd, flowAt(g.ids, left, blockW, y + HEAD, perRow));
      });
      y = rowEnd + gap;
    }
    for (const g of (view.groups ?? []).filter((g) => !g.key.startsWith('q-t') && !g.key.startsWith('q-b'))) {
      labels.push({ key: g.key, label: g.label, x: pad, y: y + 10 });
      y = flow(g.ids, y + HEAD, cols) + gap;
    }
    return done(Math.max(width, pad * 2 + blockW * 2 + gap), y);
  }

  // orbit：order[0]（または centerId）を中心に、関連度の高い順に内側の軌道から並べる
  const centerId = view.centerId ?? view.order[0];
  const rest = view.order.filter((id) => id !== centerId);
  const step = cell * 1.1;
  const rings: string[][] = [];
  for (let idx = 0, k = 1; idx < rest.length; k++) {
    const capacity = Math.max(1, Math.floor((2 * Math.PI * (k * step)) / cell));
    rings.push(rest.slice(idx, idx + capacity));
    idx += capacity;
  }
  const maxR = rings.length * step;
  const w = Math.max(width, 2 * maxR + orb + pad * 2);
  const h = 2 * maxR + orb + pad * 2;
  const cx = w / 2;
  const cy = h / 2;

  positions[centerId] = { x: cx, y: cy };
  rings.forEach((ring, ri) => {
    const r = (ri + 1) * step;
    ring.forEach((id, j) => {
      const a = (2 * Math.PI * j) / ring.length - Math.PI / 2 + ri * 0.5; // 軌道ごとに少しずらす
      positions[id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
  });
  return { positions, labels, size: { width: w, height: h } };
}
