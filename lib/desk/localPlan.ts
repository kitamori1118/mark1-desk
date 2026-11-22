import type { DeskNode, ExecutionPlan, NodeFilter, PlanItem } from './types';
import { isArchived, matchesFilter, nodeTags, toDay, dueOf } from './selector';
import { addDays, parseDateJa } from './localDate';
import { briefingText, countText } from './localReport';
import { similarity } from './similar';

/*
 * 高速パス：定型の指令は、AIを呼ばずにその場でプランを作る（待ち時間ほぼゼロ・無料枠も消費しない）。
 *   削除・アーカイブ・ピン・透明度・色・スキャン・フォーカス・ステージ・期限（設定／ずらし／解除）・タグ付け／外し
 *   一覧・並べ替え・時系列（日／週／月／時間／時間帯）・カンバン・グループ化・色分け
 *   概況レポート・件数・検索・重複の検出／統合・線のつなぎ／外し・見た目リセット
 * 判断が必要・曖昧・複数の操作が混ざる指令、対象が見つからない指令は null を返し、AIに任せる。
 * 生成されるプランは AI のプランと同じ形式なので、実行・Undo・検証は共通。
 */

/* ---------------- 色 ---------------- */

const COLOR_TABLE: [string, string][] = [
  ['黄緑|ライム', 'lime'],
  ['シアン|水色', 'cyan'],
  ['ブルー|青', 'blue'],
  ['バイオレット|パープル|紫', 'violet'],
  ['ピンク|桃色|桃', 'pink'],
  ['クリムゾン|レッド|赤', 'crimson'],
  ['オレンジ|橙', 'orange'],
  ['アンバー|琥珀|黄色|黄', 'amber'],
  ['エメラルド|グリーン|緑', 'emerald'],
  ['灰色|グレー|スレート|灰', 'slate'],
];
const COLOR_WORD = `(${COLOR_TABLE.flatMap(([w]) => w.split('|')).sort((a, b) => b.length - a.length).join('|')})`;
const colorOf = (w: string): string => COLOR_TABLE.find(([ws]) => ws.split('|').includes(w))?.[1] ?? 'cyan';
const COLOR_ACTION = new RegExp(`${COLOR_WORD}(色)?(に|へ)(して|変えて|変更して|染めて|する)`);

/* ---------------- 共通の正規表現 ---------------- */

// 質問・判断が要る指令は AI へ
const QUESTION_RE = /(教えて|どれ|どの|なぜ|何が|何を|いくつ|ですか|ますか|でしょうか|かな$|[?？])/;
const AI_RE =
  /(まとめ|要約|分類|整理|関連|統合|重複|分解|分割|書き直|言い換|整えて|優先|重要|緊急|テーマ|似た|仕分|マトリクス|広げ|アイデア出|ToDo|TODO|抽出|洗い出|つない|繋|結んで|線を|期限を(設定|付|決)|タグを?(付|つけ)|矛盾|リスク|分析|提案|考えて|ついで|あと|それから|そして|その後|してから)/;

const ACTION_STRIP = new RegExp(
  [
    '削除|消去|消して|消す|消せ|削って|ゴミ箱(に入れて|へ)?',
    'アーカイブ(して|に)?|しまって|しまう|片付けて|保管|復元|出して|(元に)?戻(して|す|せ)',
    'ピン(?!ク)(留め|止め)?(を)?(外|解除|取)(して|す|せ)?|ピン(?!ク)(留め|止め)?(を)?(して|付け|つけ)?',
    '(完全に|うっすら|すこし|少し)?(半透明|透明|透過|薄く|薄め|薄い|うすく|濃く|不透明|くっきり|はっきり)(に|な|度)?',
    '\\d{1,3}\\s*[%％](に|で)?',
    `${COLOR_WORD}(色)?(に|へ)(して|変えて|変更して|染めて|する)`,
    '色分け(して)?',
    '(スキャン|コメント|診断)(モード)?(を)?(解除|消|オフ|外|閉じ)(して|す)?',
    '(スキャン|診断|チェック)(して)?',
    '(フォーカス|強調|ズーム|ハイライト)(を)?(解除|戻|消|やめ|外)(して|す)?',
    '(フォーカス|強調|ズーム|ハイライト|目立たせ)(して|する)?',
    '探して|さがして|検索(して)?|見つけて',
    '(未着手|進行中|完了|終わった|終了)(に|へ)(して|変更して|する|変えて)',
    '(最新|直近|最近)(の)?\\d+\\s*件(だけ)?|古い(の)?\\d+\\s*件(だけ)?',
    '(記入|書いた|入力|編集|更新|修正)(した)?(日時|時間|時刻)(順|ごと|別)?',
    '(時間|時刻|時間帯|日時|記入)(順|ごと|別|単位)(に)?',
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
const TRIM_PARTICLES = /^(の|を|は|が|に|で|も|と|から|\s)+|(の|を|は|が|に|で|も|と|から|\s)+$/g;

/* ---------------- 選択（セレクター） ---------------- */

interface Ctx {
  nodes: DeskNode[];
  now: Date;
  knownTags: string[];
}
interface Sel {
  filter: NodeFilter;
  all: boolean;
  has: boolean;
}

const TOD: Record<string, [number, number]> = {
  深夜: [0, 5],
  朝: [5, 9],
  午前中: [5, 12],
  午前: [5, 12],
  午後: [12, 18],
  夕方: [17, 20],
  夜: [20, 24],
};

function parseSelector(source: string, ctx: Ctx, kind: string): Sel {
  const { now, knownTags } = ctx;
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

  // 記入した時間帯（朝に書いた／夜のメモ／18時以降／9時〜12時）
  const rangeEnd = '(の|に書いた|に記入した)?(もの|ノード|オーブ|メモ)?';
  take(new RegExp(`(\\d{1,2})時(?:から|〜|~|-)(\\d{1,2})時${rangeEnd}`), (m) => {
    filter.hourFrom = Number(m[1]);
    filter.hourTo = Number(m[2]);
  });
  take(new RegExp(`(\\d{1,2})時(?:台)?(?:から|以降)${rangeEnd}`), (m) => (filter.hourFrom = Number(m[1])));
  take(new RegExp(`(\\d{1,2})時(?:まで|より前|以前)${rangeEnd}`), (m) => (filter.hourTo = Number(m[1])));
  take(/(深夜|朝|午前中|午前|午後|夕方|夜)(に|の)(書いた|記入した|記入|入れた|追加した|作った|入力した)(もの|ノード|オーブ|メモ)?/, (m) => {
    [filter.hourFrom, filter.hourTo] = TOD[m[1]];
  });
  take(/(深夜|朝|午前中|午前|午後|夕方|夜)の(もの|ノード|オーブ|メモ)/, (m) => {
    [filter.hourFrom, filter.hourTo] = TOD[m[1]];
  });

  take(/(未着手|進行中|完了)(済み|した|の|な|している)?(もの|ノード|オーブ|タスク|メモ)?/, (m) => (filter.stage = m[1]));
  take(/(期限切れ|期限超過|期限を過ぎた|過ぎた)(の)?/, () => (filter.overdue = true));
  take(/期限(が)?(近い|間近)(の)?/, () => (filter.dueWithinDays = 3));
  take(/期限(が)?(ない|なし|未設定)(の)?/, () => (filter.noDue = true));
  if (kind !== 'pin' && kind !== 'pin_off') take(/ピン留め(された|されてる|してる|済み)?(の)?/, () => (filter.pinned = true));
  take(/アーカイブ(済み|された|してある)(の)?/, () => (filter.archived = true));
  take(new RegExp(`${COLOR_WORD}(色)?(い|の)(もの|ノード|オーブ|やつ)`), (m) => (filter.color = colorOf(m[1])));

  // 記入した日・期間
  const day = toDay(now);
  take(/昨日(作った|追加した|入れた|書いた|記入した|の)(もの|ノード|オーブ|メモ)?/, () => {
    filter.createdAfter = addDays(day, -1);
    filter.createdBefore = addDays(day, -1);
  });
  take(/今日(作った|追加した|入れた|書いた|記入した|の)(もの|ノード|オーブ|メモ)?/, () => (filter.createdAfter = day));
  take(/(今週|最近)(作った|追加した|入れた|書いた|記入した|の)(もの|ノード|オーブ|メモ)?/, () => (filter.createdWithinDays = 7));
  take(/直近(\d+)日(間)?(の|に作った)?/, (m) => (filter.createdWithinDays = Number(m[1])));
  take(/(\d+)\s*日(以上)?(前|経過した?|たった|放置された?)(に作った|に書いた|に記入した|の)?(もの|ノード|オーブ|メモ)?/, (m) => (filter.createdBefore = addDays(day, -Number(m[1]))));
  take(/(\d+)\s*週間(以上)?(前|経過した?)(に作った|に書いた|の)?(もの|ノード|オーブ|メモ)?/, (m) => (filter.createdBefore = addDays(day, -7 * Number(m[1]))));
  take(/(\d+)\s*(?:か|ヶ|カ|ケ)月(以上)?(前|経過した?)(に作った|に書いた|の)?(もの|ノード|オーブ|メモ)?/, (m) => (filter.createdBefore = addDays(day, -30 * Number(m[1]))));

  if (!filter.keyword) {
    take(/(.{1,20}?)(に関する|に関連する|について(の)?|に関わる|を含む|が入っ?て(る|いる)|と書いて(ある|いる))/, (m) => (filter.keyword = m[1].trim()));
  }
  if (!filter.keyword) take(/(.{1,20}?)の(もの|ノード|オーブ|メモ|やつ)/, (m) => (filter.keyword = m[1].trim()));

  if (!filter.keyword && !filter.tags && !filter.stage) {
    // 残った語を検索語にする（「タスクを削除」→ タスク）
    const left = s.replace(NOISE_WORDS, ' ').replace(/[、,。]/g, ' ').trim().replace(TRIM_PARTICLES, '');
    if (left.length >= 1 && left.length <= 16 && !/\s/.test(left) && !STOP_KEYWORDS.has(left)) filter.keyword = left;
  }
  if (filter.keyword) filter.keyword = filter.keyword.replace(TRIM_PARTICLES, '').trim();
  if (filter.keyword !== undefined && (!filter.keyword || STOP_KEYWORDS.has(filter.keyword))) delete filter.keyword;

  const has = all || Object.values(filter).some((v) => v !== undefined && v !== null && v !== '');
  return { filter, all, has };
}

/** 選択を実ノードに当てはめる。見つからなければ matched は空 */
function resolve(sel: Sel, ctx: Ctx, extra: NodeFilter = {}) {
  const filter: NodeFilter = { ...sel.filter, ...extra };
  const wantArchived = filter.archived === true;
  const pool = ctx.nodes.filter((n) => isArchived(n) === wantArchived);
  const hasCond = Object.keys(filter).length > 0;
  const matched = hasCond ? pool.filter((n) => matchesFilter(n, filter, ctx.now)) : pool;
  const target: PlanItem['target'] = hasCond ? { filter } : { all: true };
  return { filter, matched, hasCond, target };
}

/* ---------------- プランの部品 ---------------- */

const item = (tool: string, target: PlanItem['target'], args: Record<string, any> = {}): PlanItem => ({ tool, target, args });
const plan = (label: string, ...items: PlanItem[]): ExecutionPlan => ({ message: `⚡ ${label}`, plan: items, unsupported: null, clarify: null });
const reportPlan = (title: string, text: string): ExecutionPlan => plan(title, item('report', {}, { title, text }));

type Res = ExecutionPlan | null | 'skip';

const shortOf = (n: DeskNode, len = 14) => (n.content.length > len ? `${n.content.slice(0, len)}…` : n.content);

/** 「見積」のような語に合うノードを1つ選ぶ（一番内容が近い＝短いもの） */
function findOne(ctx: Ctx, kw: string): DeskNode | null {
  const hits = ctx.nodes.filter((n) => !isArchived(n) && n.content.includes(kw));
  return hits.sort((a, b) => a.content.length - b.content.length)[0] ?? null;
}

/* ---------------- 個別ハンドラ ---------------- */

/** 線：「A」と「B」をつないで／線を外して／線を全部消して */
function tryLinks(c: string, ctx: Ctx): Res {
  const pair = c.match(/[「『]([^」』]+)[」』]\s*(?:と|を|に|から)\s*[「『]([^」』]+)[」』]/);
  const cutting = /(消|外|切|解除)/.test(c);
  if (/(線|接続|リンク|つながり)(を)?(全部|すべて|全て)/.test(c) && cutting) return plan('すべての線を外す', item('unlink', { all: true }, { all: true }));
  if (!pair) return 'skip';
  if (/(線|接続|リンク|つながり)/.test(c) && cutting) {
    const a = findOne(ctx, pair[1]);
    const b = findOne(ctx, pair[2]);
    return a && b ? plan('線を外す', item('unlink', {}, { pairs: [{ from: a.id, to: b.id }] })) : null;
  }
  if (/(つない|繋い|結ん|リンクして)/.test(c)) {
    const a = findOne(ctx, pair[1]);
    const b = findOne(ctx, pair[2]);
    return a && b && a.id !== b.id ? plan('2件をつなぐ', item('link_nodes', {}, { pairs: [{ from: a.id, to: b.id }] })) : null;
  }
  return 'skip';
}

/** 重複：探す／統合する（統合後の文面は、いちばん長い内容を残す） */
function tryDuplicates(c: string, ctx: Ctx): Res {
  if (!/(重複|ダブり|ダブって|かぶって|被って)/.test(c)) return 'skip';
  if (/(統合|マージ|まとめ|一つに|1つに|併合)/.test(c)) {
    const live = ctx.nodes.filter((n) => !isArchived(n)).slice(0, 200);
    const parent = live.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        if (similarity(live[i].content, live[j].content) >= 0.6) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, DeskNode[]>();
    live.forEach((n, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), n]));
    const merges = [...groups.values()].filter((g) => g.length >= 2).slice(0, 20);
    if (!merges.length) return reportPlan('重複の統合', '統合できる重複は見つかりませんでした。');
    return plan(
      `${merges.length}グループを統合`,
      item('merge_duplicates', {}, {
        groups: merges.map((g) => ({ ids: g.map((n) => n.id), mergedContent: [...g].sort((a, b) => b.content.length - a.content.length)[0].content })),
      })
    );
  }
  if (/(探|見つけ|チェック|検出|調べ|洗い出|教え|ある|いる|確認)/.test(c)) return plan('重複を検出', item('find_duplicates', { all: true }, { threshold: 0.55 }));
  return 'skip';
}

/** 概況・件数のレポート（AIなし） */
function tryReports(c: string, ctx: Ctx): Res {
  if (/(何件|いくつ|件数|数えて|何個)/.test(c)) {
    const sel = parseSelector(c.replace(/(何件|いくつ|件数|数えて|何個|ある|あります|ですか|ますか|[?？])/g, ' ').replace(/(か|は|って)\s*$/, ' '), ctx, 'count');
    const live = ctx.nodes.filter((n) => !isArchived(n));
    const r = sel.has ? resolve(sel, ctx) : { matched: live };
    const label = sel.filter.keyword ?? (sel.filter.tags ? `@${sel.filter.tags.join(' @')}` : sel.filter.stage ?? (sel.has ? '条件に合うもの' : '全体'));
    return reportPlan('件数', countText(label, r.matched, live.length));
  }
  if (c.length <= 24 && /(今日|本日)(の)?(やること|予定|タスク|状況)|ブリーフィング|概況|サマリー|ダッシュボード|全体像|状況を?(見せて|報告|教えて)?$|おはよう/.test(c)) {
    return reportPlan('概況', briefingText(ctx.nodes, ctx.now));
  }
  return 'skip';
}

/** 期限：設定（日付／本文から読み取り）・ずらし・解除 */
function tryDue(c: string, ctx: Ctx): Res {
  const viewish = /(一覧|リスト|グリッド|並べ|ならべ|表示|見せ|探|検索|削除|アーカイブ|透明|薄|ピン|色)/;
  const dueWord = /(期限|締切|締め切り|〆)/;

  // 解除
  if (/(期限|締切|締め切り|〆)(を)?(なし|ない|消し|クリア|外し|はずし|解除|取り消し|リセット)/.test(c)) {
    const sel = parseSelector(c.replace(/(期限|締切|締め切り|〆)(を)?(なし|ない|消し|クリア|外し|はずし|解除|取り消し|リセット)(に)?(して)?/, ' '), ctx, 'due');
    if (!sel.has) return null;
    const r = resolve(sel, ctx);
    const withDue = r.matched.filter((n) => dueOf(n));
    return withDue.length ? plan(`${withDue.length}件の期限を解除`, item('set_due', r.target, { clear: true })) : null;
  }
  // ずらし（延期・前倒し）
  const shift = c.match(/(\d+)\s*(日|週間)(ほど)?(延ばし|延期|遅らせ|先送り|後ろ倒し|ずらし|繰り下げ|前倒し|早め|繰り上げ|早く)(?:して|て|する)?/);
  if (shift) {
    const n = Number(shift[1]) * (shift[2] === '週間' ? 7 : 1);
    const back = /(前倒し|早め|繰り上げ|早く)/.test(shift[4]);
    const sel = parseSelector(c.replace(shift[0], ' ').replace(/期限(を|は)?/g, ' '), ctx, 'due');
    if (!sel.has) return null;
    const r = resolve(sel, ctx);
    const withDue = r.matched.filter((x) => dueOf(x));
    return withDue.length ? plan(`${withDue.length}件の期限を${n}日${back ? '前倒し' : '延期'}`, item('set_due', r.target, { shiftDays: back ? -n : n })) : null;
  }
  // 設定
  if (viewish.test(c)) return 'skip';
  const wantsDue = dueWord.test(c) || /までに?(して|する|設定|変更)/.test(c);
  if (!wantsDue) return 'skip';
  const parsed = parseDateJa(c, ctx.now);
  if (parsed) {
    const rest = c.replace(parsed.text, ' ').replace(/(期限|締切|締め切り|〆)(を|は)?|までに?|(に|へ)(して|する|変更して|設定して|変えて)|設定して|入れて|つけて|付けて/g, ' ');
    const sel = parseSelector(rest, ctx, 'due');
    if (!sel.has) return null;
    const r = resolve(sel, ctx);
    return r.matched.length ? plan(`${r.matched.length}件の期限を ${parsed.date} に`, item('set_due', r.target, { due: parsed.date })) : null;
  }
  // 日付の指定が無い：「〇〇の期限を設定して」→ 各ノードの本文から日付を読み取る（記入日を基準にする）
  if (/(設定|付け|つけ)/.test(c)) {
    const sel = parseSelector(c.replace(/(期限|締切|締め切り|〆)(を|の)?|設定(して)?|付けて|つけて/g, ' '), ctx, 'due');
    if (!sel.has) return null;
    const r = resolve(sel, ctx);
    const assignments = r.matched
      .map((n) => ({ id: n.id, p: parseDateJa(n.content, toDay(n.created_at)) }))
      .filter((x): x is { id: string; p: NonNullable<typeof x.p> } => !!x.p)
      .map((x) => ({ id: x.id, due: x.p.date }));
    return assignments.length ? plan(`${assignments.length}件の期限を本文から設定`, item('set_due', {}, { assignments })) : null;
  }
  return 'skip';
}

/** タグ：「〇〇に@急ぎをつけて」「〇〇から@急ぎを外して」 */
function tryTags(c: string, ctx: Ctx): Res {
  const add = c.match(/^(.*?)に[@＠]([^\s@、,。]+?)(?:という)?(?:タグ)?(?:を)?(?:つけて|付けて|つけ|付け|付与|追加)/);
  if (add) {
    const sel = parseSelector(add[1], ctx, 'tag');
    if (!sel.has) return null;
    const r = resolve(sel, ctx);
    return r.matched.length ? plan(`${r.matched.length}件に @${add[2]} を付与`, item('auto_tag', r.target, { tags: [add[2]] })) : null;
  }
  const del = c.match(/^(.*?)(?:から|の)?[@＠]([^\s@、,。]+?)(?:タグ)?(?:を)?(?:外して|はずして|消して|削除|取って|取り除)/);
  if (del) {
    const sel = parseSelector(del[1].replace(/(から|の)$/, ''), ctx, 'tag');
    const r = sel.has ? resolve(sel, ctx) : resolve({ filter: { tags: [del[2]] }, all: false, has: true }, ctx);
    return r.matched.length ? plan(`${r.matched.length}件から @${del[2]} を外す`, item('auto_tag', r.target, { remove: [del[2]] })) : null;
  }
  return 'skip';
}

/** 検索：「〇〇を探して」→ 該当をフォーカス（他は薄く） */
function trySearch(c: string, ctx: Ctx): Res {
  if (!/(探して|さがして|検索|見つけて)/.test(c) || /(重複|ダブり)/.test(c)) return 'skip';
  const sel = parseSelector(c, ctx, 'search');
  if (!sel.has) return null;
  const r = resolve(sel, ctx);
  if (!r.matched.length) return reportPlan('検索', `「${sel.filter.keyword ?? '条件'}」に合うノードは見つかりませんでした。`);
  return plan(`🔎 ${r.matched.length}件が見つかりました`, item('zoom', r.target, { focus: true, dimOthers: true }));
}

/** 重ねる／ばらす：「〇〇を重ねて」「カテゴリごとに重ねて」「ばらして」 */
function tryStack(c: string, ctx: Ctx): Res {
  const unstack =
    /(ばらして|バラして|ばらす|バラす)|スタック.{0,4}(解除|解いて|ほどいて|崩して)|重ね.{0,4}(解除|ほどいて|解いて|崩して)|重なり.{0,3}(解除|なくして|直して)|山.{0,3}(崩して|ばらして)/;
  if (unstack.test(c)) {
    const sel = parseSelector(c.replace(unstack, ' '), ctx, 'unstack');
    const r = sel.has ? resolve(sel, ctx, { stacked: true }) : resolve({ filter: {}, all: false, has: true }, ctx, { stacked: true });
    return r.matched.length ? plan(`${r.matched.length}件の重なりをばらす`, item('unstack', r.target, {})) : null;
  }
  const stack = /(重ねて|重ねる|重ね合わせ|スタック(して|する)?|積み重ね|積んで|山にして|山積み)/;
  if (!stack.test(c)) return 'skip';
  const by = /(部署|カテゴリ)(ごと|別)/.test(c)
    ? 'category'
    : /タグ(ごと|別)/.test(c)
    ? 'tag'
    : /(ステージ|進行状況|進捗)(ごと|別)/.test(c)
    ? 'stage'
    : /色(ごと|別)/.test(c)
    ? 'color'
    : /(状態|ステータス)(ごと|別)/.test(c)
    ? 'status'
    : null;
  const rest = c.replace(/(部署|カテゴリ|タグ|ステージ|進行状況|進捗|色|状態|ステータス)(ごと|別)(に)?/g, ' ').replace(stack, ' ');
  const sel = parseSelector(rest, ctx, 'stack');
  if (!sel.has && !by) return null;
  const r = sel.has ? resolve(sel, ctx) : resolve({ filter: {}, all: true, has: true }, ctx);
  if (r.matched.length < 2) return null;
  return plan(`${r.matched.length}件を重ねる`, item('stack_nodes', r.target, by ? { by } : {}));
}

/** 期限が近い・切れているものの警告＋期限順の一覧 */
export function deadlinePlan(nodes: DeskNode[], now: Date): ExecutionPlan {
  const near = nodes.filter((n) => !isArchived(n) && matchesFilter(n, { dueWithinDays: 3 }, now)).length;
  const items: PlanItem[] = [item('deadline_alert', { all: true }, { withinDays: 3 })];
  if (near) items.push(item('arrange_view', { filter: { dueWithinDays: 3 } }, { layout: 'list', sortBy: 'due', title: '期限が近い順' }));
  return plan('期限を確認', ...items);
}

function tryDeadlineView(c: string, ctx: Ctx): Res {
  if (/期限.{0,3}(が近い|間近|切れ|超過|ヤバ|やばい)|遅れて(る|いる)/.test(c) && !AI_RE.test(c) && !/(削除|アーカイブ|色|透明|どれ|どの|なぜ|[?？])/.test(c)) {
    return deadlinePlan(ctx.nodes, ctx.now);
  }
  return 'skip';
}

/** リセット系 */
function tryReset(c: string, ctx: Ctx): Res {
  if (/見た目(を)?(リセット|元に戻|初期化)/.test(c)) {
    return plan(
      '見た目をリセット',
      item('zoom', {}, { reset: true }),
      item('spectrum_shift', { all: true }, { opacity: 1 }),
      item('diagnostic_scan', { filter: { status: 'scanned' } }, { status: 'normal', commentMode: false }),
      item('reset_view', {})
    );
  }
  if (/色(を)?(リセット|元に戻|初期化|デフォルト)/.test(c)) {
    const sel = parseSelector(c.replace(/色(を)?(リセット|元に戻して?|初期化|デフォルトに?)(して)?/, ' '), ctx, 'color');
    const r = sel.has ? resolve(sel, ctx) : { matched: ctx.nodes.filter((n) => !isArchived(n)), target: { all: true } as PlanItem['target'] };
    return r.matched.length ? plan(`${r.matched.length}件の色をリセット`, item('spectrum_shift', r.target, { color: 'cyan' })) : null;
  }
  return 'skip';
}

/* ---------------- 汎用（操作の種類を1つ決めて実行） ---------------- */

type Kind =
  | 'reset_view' | 'scan_off' | 'scan' | 'zoom_reset' | 'zoom' | 'restore' | 'archive' | 'pin_off' | 'pin'
  | 'delete' | 'opacity' | 'color' | 'colorby' | 'stage' | 'timeline' | 'kanban' | 'group' | 'arrange';

function detectKinds(c: string): Kind[] {
  const f = (re: RegExp) => re.test(c);
  if (f(/(整列|並び|配置|表示|一覧|ビュー).{0,6}(解除|戻|元に|やめ|リセット|クリア)|自由配置|元の配置/)) return ['reset_view'];

  const scanOff = f(/(スキャン|コメント|診断)(モード)?(を)?(解除|消|オフ|外|閉じ)/);
  const zoomReset = f(/(フォーカス|強調|ズーム|ハイライト)(を)?(解除|戻|消|やめ|外)/);
  const restore = f(/(アーカイブ|保管).{0,8}(戻|復元|出)|復元/);
  const pinOff = f(/ピン(?!ク)(留め|止め)?(を)?(外|解除|取)/);
  const colorby = f(/色分け/);
  const kanban = f(/カンバン/);
  const timeline = f(/(週|月|日|時期|期間|時間|時刻|時間帯)(ごと|別|単位)|時系列|タイムライン|時間帯/);
  const group = !kanban && !colorby && !timeline && f(/(部署|カテゴリ|色|状態|ステータス|ステージ|タグ|進行状況|進捗)(ごと|別)/);

  const kinds: Kind[] = [];
  if (scanOff) kinds.push('scan_off');
  else if (f(/(スキャン|診断|チェック)/)) kinds.push('scan');
  if (zoomReset) kinds.push('zoom_reset');
  else if (f(/(フォーカス|強調|ズーム|ハイライト|目立たせ)/)) kinds.push('zoom');
  if (restore) kinds.push('restore');
  else if (f(/(アーカイブ|しまって|しまう|片付け|保管)/)) kinds.push('archive');
  if (pinOff) kinds.push('pin_off');
  else if (f(/ピン(?!ク)/)) kinds.push('pin');
  if (!scanOff && f(/(削除|消去|消して|消す|消せ|削って|ゴミ箱)/)) kinds.push('delete');
  if (f(/(透明|透過|薄く|薄め|薄い|うすく|半透明|フェード|濃く|不透明|くっきり|はっきり)|\d{1,3}\s*[%％]/)) kinds.push('opacity');
  if (colorby) kinds.push('colorby');
  else if (COLOR_ACTION.test(c)) kinds.push('color');
  if (f(/(未着手|進行中|完了|終わった|終了)(に|へ)(して|変更|する|変えて)/)) kinds.push('stage');
  if (timeline) kinds.push('timeline');
  if (kanban) kinds.push('kanban');
  if (group) kinds.push('group');
  if (
    !timeline && !kanban && !group &&
    f(/(一覧|リスト|グリッド|並べ|ならべ|ソート)|(だけ|のみ).{0,3}(表示|見せ|出し)|(時間|時刻|日時|記入|編集|更新|修正)(した)?(日時|時間|時刻)?順|(最新|直近|最近|古い)(の)?\d+\s*件/)
  ) kinds.push('arrange');
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

function generic(c: string, ctx: Ctx): ExecutionPlan | null {
  if (QUESTION_RE.test(c) || AI_RE.test(c)) return null;
  const kinds = detectKinds(c);
  if (kinds.length !== 1) return null; // 何も無い／複数の操作が混ざる → AI
  const kind = kinds[0];

  if (kind === 'reset_view') return plan('自由配置に戻します', item('reset_view', {}));
  if (kind === 'zoom_reset') return plan('フォーカスを解除', item('zoom', {}, { reset: true }));

  const sel = parseSelector(c, ctx, kind);
  const isView = ['timeline', 'kanban', 'group', 'arrange', 'colorby'].includes(kind);
  if (!sel.has && !isView && kind !== 'restore') return null; // 対象が分からない → AI（または聞き返し）。復元は「アーカイブ済み全部」でよい

  const r = resolve(sel, ctx, kind === 'restore' ? { archived: true } : {});
  if (r.matched.length === 0) return null; // 見つからない → AIに意味で探してもらう
  const { target } = r;
  const n = r.matched.length;

  switch (kind) {
    case 'delete':
      return plan(`${n}件を削除`, item('delete_nodes', target, { all: sel.all && !r.hasCond }));
    case 'archive':
      return plan(`${n}件をアーカイブ`, item('archive', target, {}));
    case 'restore':
      return plan(`${n}件を復元`, item('archive', target, { restore: true }));
    case 'pin':
      return plan(`${n}件をピン留め`, item('pin', target, { pinned: true }));
    case 'pin_off':
      return plan(`${n}件のピンを解除`, item('pin', target, { pinned: false }));
    case 'opacity': {
      const o = opacityOf(c);
      return plan(`${n}件の透明度を${Math.round(o * 100)}%に`, item('spectrum_shift', target, { opacity: o }));
    }
    case 'color': {
      const m = c.match(COLOR_ACTION);
      return plan(`${n}件の色を変更`, item('spectrum_shift', target, { color: colorOf(m ? m[1] : '') }));
    }
    case 'colorby': {
      const by = /(経過|古さ|新しさ|日数)/.test(c) ? 'age' : /(状態|ステータス)/.test(c) ? 'status' : /(部署|カテゴリ)/.test(c) ? 'category' : null;
      return by ? plan(`${by}別に色分け`, item('spectrum_shift', r.hasCond ? target : { all: true }, { by })) : null;
    }
    case 'scan':
      return plan(`${n}件をスキャン`, item('diagnostic_scan', target, { status: 'scanned', commentMode: true }));
    case 'scan_off':
      return plan(`${n}件のスキャンを解除`, item('diagnostic_scan', target, { status: 'normal', commentMode: false }));
    case 'zoom':
      return plan(`${n}件にフォーカス`, item('zoom', target, { focus: true, dimOthers: true }));
    case 'stage': {
      const m = c.match(/(未着手|進行中|完了|終わった|終了)(に|へ)/);
      const stage = m ? (m[1] === '終わった' || m[1] === '終了' ? '完了' : m[1]) : null;
      return stage ? plan(`${n}件を「${stage}」に`, item('set_stage', target, { stage })) : null;
    }
    case 'timeline': {
      const by = /(編集|更新|修正)/.test(c) ? 'updated' : /期限/.test(c) ? 'due' : 'created_at';
      const bucket = /時間帯/.test(c)
        ? 'daypart'
        : /(時間|時刻)(ごと|別|単位)/.test(c) && by !== 'due'
        ? 'hour'
        : /月(ごと|別|単位)/.test(c)
        ? 'month'
        : /日(ごと|別|単位)/.test(c)
        ? 'day'
        : 'week';
      const order = /新しい順|降順|最新/.test(c) ? 'desc' : 'asc';
      return plan(`${n}件を時系列に`, item('timeline_view', target, { bucket, by, order }));
    }
    case 'kanban':
      return plan(`${n}件をカンバンに`, item('group_view', target, { by: 'stage', layout: 'kanban' }));
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
      return plan(`${by}別にグループ化`, item('group_view', target, { by }));
    }
    case 'arrange': {
      const args: Record<string, any> = { layout: /グリッド/.test(c) ? 'grid' : 'list' };
      const lim = c.match(/(最新|直近|最近|古い)(の)?(\d+)\s*件/);
      if (lim) {
        Object.assign(args, { sortBy: 'created_at', order: lim[1] === '古い' ? 'asc' : 'desc', limit: Number(lim[3]) });
      } else if (/時刻順/.test(c)) Object.assign(args, { sortBy: 'time_of_day', order: 'asc' });
      else if (/(編集|更新|修正).{0,4}(順|日時|時間)/.test(c)) Object.assign(args, { sortBy: 'updated', order: /新しい|最近|最新/.test(c) ? 'desc' : 'asc' });
      else if (/新しい順/.test(c)) Object.assign(args, { sortBy: 'created_at', order: 'desc' });
      else if (/古い順|作成順|記入順|(時間|日時|記入|書いた).{0,3}順/.test(c)) Object.assign(args, { sortBy: 'created_at', order: 'asc' });
      else if (/期限順/.test(c)) Object.assign(args, { sortBy: 'due', order: 'asc' });
      else if (/(カテゴリ|部署)順/.test(c)) Object.assign(args, { sortBy: 'category' });
      else if (/色順/.test(c)) Object.assign(args, { sortBy: 'color' });
      else if (/文字数|長い順/.test(c)) Object.assign(args, { sortBy: 'length', order: 'desc' });
      else if (/短い順/.test(c)) Object.assign(args, { sortBy: 'length', order: 'asc' });
      return plan(`${Math.min(n, args.limit ?? n)}件を${args.layout === 'grid' ? 'グリッド' : '一覧'}表示`, item('arrange_view', target, args));
    }
    default:
      return null;
  }
}

/* ---------------- 入口 ---------------- */

export function localPlan(raw: string, nodes: DeskNode[], now = new Date()): ExecutionPlan | null {
  const c = raw.trim().replace(/[。.!！]+$/g, '');
  if (!c || c.length > 80) return null;

  const knownTags = [...new Set(nodes.flatMap((n) => [n.category, ...(Array.isArray(n.metadata?.tags) ? (n.metadata.tags as string[]) : [])]))]
    .filter(Boolean)
    .sort((x, y) => y.length - x.length);
  const ctx: Ctx = { nodes, now, knownTags };

  // 先に当てはまったハンドラが答えを決める（null = 当てはまったが自信が無い → AI）
  for (const handler of [tryStack, tryLinks, tryDuplicates, tryReports, tryDue, tryTags, trySearch, tryReset, tryDeadlineView]) {
    const r = handler(c, ctx);
    if (r !== 'skip') return r;
  }
  return generic(c, ctx);
}

// 型の再利用のため
export type { Ctx as LocalCtx };
export { nodeTags as _nodeTags };
