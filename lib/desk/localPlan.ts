import type { DeskNode, ExecutionPlan, NodeFilter, PlanItem } from './types';
import { matchesFilter, toDay } from './selector';

/*
 * 高速パス：定型の指令は、AIを呼ばずにその場でプランを作る（待ち時間ほぼゼロ・無料枠も消費しない）。
 *   「タスクに関するものを削除して」「@アイデアを薄くして」「週ごとに並べて」「完了したものをアーカイブして」など。
 * 判断が必要・曖昧・複数の操作が混ざる指令、対象が見つからない指令は null を返し、AIに任せる。
 * 生成されるプランは AI のプランと同じ形式なので、実行・Undo・検証は共通。
 */

const COLOR_WORD = '(シアン|水色|青|アンバー|琥珀|オレンジ|黄色|黄|クリムゾン|赤|エメラルド|緑)';
const colorOf = (w: string): string =>
  /シアン|水色|青/.test(w) ? 'cyan' : /アンバー|琥珀|オレンジ|黄/.test(w) ? 'amber' : /クリムゾン|赤/.test(w) ? 'crimson' : 'emerald';

// 質問・判断が要る指令は AI へ
const QUESTION_RE = /(教えて|どれ|どの|なぜ|何が|何を|いくつ|ですか|ますか|でしょうか|かな$|[?？])/;
const AI_RE =
  /(まとめ|要約|分類|整理|関連|統合|重複|分解|分割|書き直|言い換|整えて|優先|重要|緊急|テーマ|似た|仕分|マトリクス|広げ|アイデア出|ToDo|TODO|抽出|洗い出|つない|繋|結んで|線を|期限を(設定|付|決)|タグを?(付|つけ)|矛盾|リスク|分析|提案|考えて|ついで|あと|それから|そして|その後|してから)/;

const ACTION_STRIP = new RegExp(
  [
    '削除|消去|消して|消す|消せ|削って|ゴミ箱(に入れて|へ)?',
    'アーカイブ(して|に)?|しまって|しまう|片付けて|保管|復元|出して|(元に)?戻(して|す|せ)',
    'ピン(留め|止め)?(を)?(外|解除|取)(して|す|せ)?|ピン(留め|止め)?(を)?(して|付け|つけ)?',
    '(完全に|うっすら|すこし|少し)?(半透明|透明|透過|薄く|薄め|薄い|うすく|濃く|不透明|くっきり|はっきり)(に|な|度)?',
    '\\d{1,3}\\s*[%％](に|で)?',
    `${COLOR_WORD}(色)?(に|へ)(して|変えて|変更して|染めて|する)`,
    '色分け(して)?',
    '(スキャン|コメント|診断)(モード)?(を)?(解除|消|オフ|外|閉じ)(して|す)?',
    '(スキャン|診断|チェック)(して)?',
    '(フォーカス|強調|ズーム|ハイライト)(を)?(解除|戻|消|やめ|外)(して|す)?',
    '(フォーカス|強調|ズーム|ハイライト|目立たせ)(して|する)?',
    '(未着手|進行中|完了|終わった|終了)(に|へ)(して|変更して|する|変えて)',
    '(一覧|リスト|グリッド)(表示)?(に|で)?(して)?',
    '並べ(て|替えて)?|ならべ(て)?|ソート(して)?',
    '(新しい|古い|期限|カテゴリ|部署|色|文字数|長い|短い)順(に)?',
    '(週|月|日|時期|期間|部署|カテゴリ|色|状態|ステータス|ステージ|タグ|進行状況|進捗)(ごと|別|単位)(に)?',
    '時系列|タイムライン|カンバン',
    '見せて|表示して|出して|表示|分けて|分ける|わけて|グループ化(して)?|区切って|並び替え(て)?',
    'して(ください|くれ|ほしい)?|してね|してよ|しろ|ください|くれ|お願い(します)?|ちょっと|少し|すこし',
  ].join('|'),
  'g'
);

const NOISE_WORDS = /(もの|ノード|オーブ|メモ|やつ|だけ|のみ|全部|すべて|全て)/g;
const STOP_KEYWORDS = new Set(['それ', 'これ', 'あれ', 'さっき', 'いま', '今', '次', 'この', 'その', 'あの', '前の']);

interface Sel {
  filter: NodeFilter;
  all: boolean;
  has: boolean;
}

function parseSelector(source: string, now: Date, kind: string, knownTags: string[]): Sel {
  let s = source.replace(ACTION_STRIP, ' ');
  const filter: NodeFilter = {};
  let all = false;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re);
    if (m) {
      fn(m);
      s = s.replace(m[0], ' ');
    }
  };

  take(/(全部|すべて|全て|全オーブ|全ノード|みんな|ぜんぶ)/, () => (all = true));

  // @タグ：既知のタグ名を優先（「@アイデアを薄く」のように助詞が続いても切り出せる）。未知のタグは助詞の手前までを採用
  const tags: string[] = [];
  for (const t of knownTags) {
    if (s.includes(`@${t}`)) {
      tags.push(t);
      s = s.replace(`@${t}`, ' ');
    }
  }
  for (const m of [...s.matchAll(/@([^\s@、,。をはがにでのもと]+)/g)]) {
    tags.push(m[1]);
    s = s.replace(m[0], ' ');
  }
  if (tags.length) filter.tags = tags;
  take(/[「『"“]([^」』"”]+)[」』"”]/, (m) => (filter.keyword = m[1]));

  take(/(未着手|進行中|完了)(済み|した|の|な|している)?(もの|ノード|オーブ|タスク|メモ)?/, (m) => (filter.stage = m[1]));
  take(/(期限切れ|期限超過|期限を過ぎた|過ぎた)(の)?/, () => (filter.overdue = true));
  take(/期限(が)?(近い|間近)(の)?/, () => (filter.dueWithinDays = 3));
  take(/期限(が)?(ない|なし|未設定)(の)?/, () => (filter.noDue = true));
  if (kind !== 'pin' && kind !== 'pin_off') take(/ピン留め(された|されてる|してる|済み)?(の)?/, () => (filter.pinned = true));
  take(/アーカイブ(済み|された|してある)(の)?/, () => (filter.archived = true));
  take(new RegExp(`${COLOR_WORD}(色)?(い|の)(もの|ノード|オーブ|やつ)`), (m) => (filter.color = colorOf(m[1])));

  const day = toDay(now);
  take(/今日(作った|追加した|入れた|の)(もの|ノード|オーブ|メモ)?/, () => (filter.createdAfter = day));
  take(/(今週|最近)(作った|追加した|入れた|の)(もの|ノード|オーブ|メモ)?/, () => (filter.createdWithinDays = 7));
  take(/直近(\d+)日(間)?(の|に作った)?/, (m) => (filter.createdWithinDays = Number(m[1])));

  if (!filter.keyword) {
    take(/(.{1,20}?)(に関する|に関連する|について(の)?|に関わる|を含む|が入っ?て(る|いる)|と書いて(ある|いる))/, (m) => (filter.keyword = m[1].trim()));
  }
  if (!filter.keyword) take(/(.{1,20}?)の(もの|ノード|オーブ|メモ|やつ)/, (m) => (filter.keyword = m[1].trim()));

  if (!filter.keyword && !filter.tags && !filter.stage) {
    // 残った語を検索語にする（「タスクを削除」→ タスク）
    const left = s
      .replace(NOISE_WORDS, ' ')
      .replace(/[、,。]/g, ' ')
      .trim()
      .replace(/^(の|を|は|が|に|で|も|と|\s)+|(の|を|は|が|に|で|も|と|\s)+$/g, '');
    if (left.length >= 1 && left.length <= 16 && !/\s/.test(left) && !STOP_KEYWORDS.has(left)) filter.keyword = left;
  }
  if (filter.keyword) filter.keyword = filter.keyword.replace(/^(の|を|は|が|に|で|も|と)+|(の|を|は|が|に|で|も|と)+$/g, '').trim();
  if (filter.keyword && (STOP_KEYWORDS.has(filter.keyword) || !filter.keyword)) delete filter.keyword;

  const has = all || Object.values(filter).some((v) => v !== undefined && v !== null && v !== '');
  return { filter, all, has };
}

/* ------------------------------------------------------------------ */

type Kind =
  | 'reset_view' | 'scan_off' | 'scan' | 'zoom_reset' | 'zoom' | 'restore' | 'archive' | 'pin_off' | 'pin'
  | 'delete' | 'opacity' | 'color' | 'colorby' | 'stage' | 'timeline' | 'kanban' | 'group' | 'arrange';

function detectKinds(c: string): Kind[] {
  const f = (re: RegExp) => re.test(c);
  const reset = f(/(整列|並び|配置|表示|一覧|ビュー).{0,6}(解除|戻|元に|やめ|リセット|クリア)|自由配置|元の配置/);
  if (reset) return ['reset_view'];

  const scanOff = f(/(スキャン|コメント|診断)(モード)?(を)?(解除|消|オフ|外|閉じ)/);
  const zoomReset = f(/(フォーカス|強調|ズーム|ハイライト)(を)?(解除|戻|消|やめ|外)/);
  const restore = f(/(アーカイブ|保管).{0,8}(戻|復元|出)|復元/);
  const pinOff = f(/ピン(留め|止め)?(を)?(外|解除|取)/);
  const colorby = f(/色分け/);
  const kanban = f(/カンバン/);
  const timeline = f(/(週|月|日|時期|期間)(ごと|別|単位)|時系列|タイムライン/);
  const group = !kanban && !colorby && f(/(部署|カテゴリ|色|状態|ステータス|ステージ|タグ|進行状況|進捗)(ごと|別)/);

  const kinds: Kind[] = [];
  if (scanOff) kinds.push('scan_off');
  else if (f(/(スキャン|診断|チェック)/)) kinds.push('scan');
  if (zoomReset) kinds.push('zoom_reset');
  else if (f(/(フォーカス|強調|ズーム|ハイライト|目立たせ)/)) kinds.push('zoom');
  if (restore) kinds.push('restore');
  else if (f(/(アーカイブ|しまって|しまう|片付け|保管)/)) kinds.push('archive');
  if (pinOff) kinds.push('pin_off');
  else if (f(/ピン/)) kinds.push('pin');
  if (!scanOff && f(/(削除|消去|消して|消す|消せ|削って|ゴミ箱)/)) kinds.push('delete');
  if (f(/(透明|透過|薄く|薄め|薄い|うすく|半透明|フェード|濃く|不透明|くっきり|はっきり)|\d{1,3}\s*[%％]/)) kinds.push('opacity');
  if (colorby) kinds.push('colorby');
  else if (new RegExp(`${COLOR_WORD}(色)?(に|へ)(して|変えて|変更して|染めて|する)`).test(c)) kinds.push('color');
  if (f(/(未着手|進行中|完了|終わった|終了)(に|へ)(して|変更|する|変えて)/)) kinds.push('stage');
  if (timeline) kinds.push('timeline');
  if (kanban) kinds.push('kanban');
  if (group) kinds.push('group');
  if (!timeline && !kanban && !group && f(/(一覧|リスト|グリッド|並べ|ならべ|ソート)|(だけ|のみ).{0,3}(表示|見せ|出し)/)) kinds.push('arrange');
  return kinds;
}

function opacityOf(c: string): number {
  const inv = c.match(/透明度.{0,3}?(\d{1,3})\s*[%％]/);
  if (inv) return Math.min(1, Math.max(0, 1 - Number(inv[1]) / 100));
  const pct = c.match(/(\d{1,3})\s*[%％]/);
  if (pct) return Math.min(1, Math.max(0, Number(pct[1]) / 100));
  if (/(透明|透過|薄).{0,4}(解除|戻|やめ|なし)|濃く|不透明|くっきり|はっきり/.test(c)) return 1;
  if (/半透明/.test(c)) return 0.5;
  if (/(少し|すこし).{0,3}(薄|うす)/.test(c)) return 0.6;
  if (/薄く|薄め|薄い|うすく|フェード/.test(c)) return 0.35;
  return 0.12; // 透明・透過
}

const item = (tool: string, target: PlanItem['target'], args: Record<string, any> = {}): PlanItem => ({ tool, target, args });

export function deadlinePlan(nodes: DeskNode[], now = new Date()): ExecutionPlan {
  const near = nodes.filter((n) => !n.metadata?.archived && matchesFilter(n, { dueWithinDays: 3 }, now)).length;
  const plan: PlanItem[] = [item('deadline_alert', { all: true }, { withinDays: 3 })];
  if (near) plan.push(item('arrange_view', { filter: { dueWithinDays: 3 } }, { layout: 'list', sortBy: 'due', title: '期限が近い順' }));
  return { message: '⚡ 期限を確認', plan, unsupported: null, clarify: null };
}

export function localPlan(raw: string, nodes: DeskNode[], now = new Date()): ExecutionPlan | null {
  const c = raw.trim().replace(/[。.!！]+$/g, '');
  if (!c || c.length > 60) return null;

  // 期限系は「教えて」と言われても、警告表示と期限順の一覧で答える
  // （「どれが〜？」のような質問・分析は AI の report に任せる）
  if (/期限.{0,3}(が近い|間近|切れ|超過|ヤバ|やばい)|遅れて(る|いる)/.test(c) && !AI_RE.test(c) && !/(削除|アーカイブ|色|透明|どれ|どの|なぜ|[?？])/.test(c)) {
    return deadlinePlan(nodes, now);
  }
  if (QUESTION_RE.test(c) || AI_RE.test(c)) return null;

  const kinds = detectKinds(c);
  if (kinds.length !== 1) return null; // 何も無い／複数の操作が混ざる → AI
  const kind = kinds[0];

  const message = (label: string) => `⚡ ${label}`;

  // 対象を取らない操作
  if (kind === 'reset_view') return { message: message('自由配置に戻します'), plan: [item('reset_view', {})], unsupported: null, clarify: null };
  if (kind === 'zoom_reset') return { message: message('フォーカスを解除'), plan: [item('zoom', {}, { reset: true })], unsupported: null, clarify: null };

  const knownTags = [...new Set(nodes.flatMap((n) => [n.category, ...(Array.isArray(n.metadata?.tags) ? (n.metadata.tags as string[]) : [])]))]
    .filter(Boolean)
    .sort((x, y) => y.length - x.length);
  const sel = parseSelector(c, now, kind, knownTags);
  const viewKinds: Kind[] = ['timeline', 'kanban', 'group', 'arrange', 'colorby'];
  const isView = viewKinds.includes(kind);

  if (!sel.has && !isView && kind !== 'restore') return null; // 対象が分からない → AI（または聞き返し）。復元は「アーカイブ済み全部」でよい
  const filter: NodeFilter = { ...sel.filter };
  if (kind === 'restore') filter.archived = true;

  const wantArchived = filter.archived === true;
  const pool = nodes.filter((n) => !!n.metadata?.archived === wantArchived);
  const hasCond = Object.keys(filter).length > 0;
  const matched = hasCond ? pool.filter((n) => matchesFilter(n, filter, now)) : pool;
  if (matched.length === 0) return null; // 見つからない → AIに意味で探してもらう

  const target: PlanItem['target'] = hasCond ? { filter } : { all: true };
  const n = matched.length;
  const out = (label: string, ...items: PlanItem[]): ExecutionPlan => ({ message: message(label), plan: items, unsupported: null, clarify: null });

  switch (kind) {
    case 'delete':
      return out(`${n}件を削除`, item('delete_nodes', target, { all: sel.all && !hasCond }));
    case 'archive':
      return out(`${n}件をアーカイブ`, item('archive', target, {}));
    case 'restore':
      return out(`${n}件を復元`, item('archive', target, { restore: true }));
    case 'pin':
      return out(`${n}件をピン留め`, item('pin', target, { pinned: true }));
    case 'pin_off':
      return out(`${n}件のピンを解除`, item('pin', target, { pinned: false }));
    case 'opacity': {
      const o = opacityOf(c);
      return out(`${n}件の透明度を${Math.round(o * 100)}%に`, item('spectrum_shift', target, { opacity: o }));
    }
    case 'color': {
      const m = c.match(new RegExp(`${COLOR_WORD}(色)?(に|へ)(して|変えて|変更して|染めて|する)`));
      return out(`${n}件の色を変更`, item('spectrum_shift', target, { color: colorOf(m ? m[1] : '') }));
    }
    case 'colorby': {
      const by = /(経過|古さ|新しさ|日数)/.test(c) ? 'age' : /(状態|ステータス)/.test(c) ? 'status' : /(部署|カテゴリ)/.test(c) ? 'category' : null;
      if (!by) return null;
      return out(`${by}別に色分け`, item('spectrum_shift', hasCond ? target : { all: true }, { by }));
    }
    case 'scan':
      return out(`${n}件をスキャン`, item('diagnostic_scan', target, { status: 'scanned', commentMode: true }));
    case 'scan_off':
      return out(`${n}件のスキャンを解除`, item('diagnostic_scan', target, { status: 'normal', commentMode: false }));
    case 'zoom':
      return out(`${n}件にフォーカス`, item('zoom', target, { focus: true, dimOthers: true }));
    case 'stage': {
      const m = c.match(/(未着手|進行中|完了|終わった|終了)(に|へ)/);
      const stage = m ? (m[1] === '終わった' || m[1] === '終了' ? '完了' : m[1]) : null;
      return stage ? out(`${n}件を「${stage}」に`, item('set_stage', target, { stage })) : null;
    }
    case 'timeline': {
      const bucket = /月(ごと|別|単位)/.test(c) ? 'month' : /日(ごと|別|単位)/.test(c) ? 'day' : 'week';
      const by = /期限/.test(c) ? 'due' : 'created_at';
      const order = /新しい順|降順/.test(c) ? 'desc' : 'asc';
      return out(`${n}件を時系列に`, item('timeline_view', target, { bucket, by, order }));
    }
    case 'kanban':
      return out(`${n}件をカンバンに`, item('group_view', target, { by: 'stage', layout: 'kanban' }));
    case 'group': {
      const by = /(部署|カテゴリ)(ごと|別)/.test(c)
        ? 'category'
        : /色(ごと|別)/.test(c)
        ? 'color'
        : /(状態|ステータス)(ごと|別)/.test(c)
        ? 'status'
        : /(ステージ|進行状況|進捗)(ごと|別)/.test(c)
        ? 'stage'
        : 'tag';
      return out(`${by}別にグループ化`, item('group_view', target, { by }));
    }
    case 'arrange': {
      const args: Record<string, any> = { layout: /グリッド/.test(c) ? 'grid' : 'list' };
      if (/新しい順/.test(c)) Object.assign(args, { sortBy: 'created_at', order: 'desc' });
      else if (/古い順|作成順/.test(c)) Object.assign(args, { sortBy: 'created_at', order: 'asc' });
      else if (/期限順/.test(c)) Object.assign(args, { sortBy: 'due', order: 'asc' });
      else if (/(カテゴリ|部署)順/.test(c)) Object.assign(args, { sortBy: 'category' });
      else if (/色順/.test(c)) Object.assign(args, { sortBy: 'color' });
      else if (/文字数|長い順/.test(c)) Object.assign(args, { sortBy: 'length', order: 'desc' });
      else if (/短い順/.test(c)) Object.assign(args, { sortBy: 'length', order: 'asc' });
      return out(`${n}件を${args.layout === 'grid' ? 'グリッド' : '一覧'}表示`, item('arrange_view', target, args));
    }
    default:
      return null;
  }
}
