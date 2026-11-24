import type { ToolDef } from './types';
import { ALL_TOOLS } from './tools';

const map = new Map<string, ToolDef>(ALL_TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string): ToolDef | undefined => map.get(name);

export const toolNames = (): string[] => [...map.keys()];

/**
 * 指令の言葉から、関係しそうなツールだけを選ぶ（プロンプトが短くなり、AIが速く・迷わなくなる）。
 * 何も当てはまらない／当てはまりすぎるときは null（＝全ツールを渡す）。
 */
const HINTS: Record<string, RegExp> = {
  merge_duplicates: /統合|重複|マージ|一つに|1つに/,
  rewrite_node: /書き直|整えて|言い換|短く|要約|誤字|わかりやすく|清書|リライト/,
  split: /分解|分割|分けて|バラ|ばら/,
  auto_tag: /タグ/,
  set_due: /期限|締切|締め切り|いつまで|〆|まで/,
  set_stage: /ステージ|進行|未着手|完了|着手|ステータス|カンバン/,
  link_nodes: /線|つな|繋|結ん|関連|接続|リンク/,
  unlink: /線|外し|切っ|接続/,
  crystallize_core: /コア|結晶|親ノード|まとめ|構造化|要約/,
  extract_actions: /ToDo|TODO|タスク化|やること|アクション|抽出|洗い出/,
  expand_ideas: /アイデア|広げ|発想|ブレスト|案を|別案|派生/,
  zoom: /フォーカス|強調|ズーム|ハイライト|目立/,
  spectrum_shift: /色|透明|透過|薄|濃|不透明|染|赤|青|緑/,
  pin: /ピン/,
  archive: /アーカイブ|しまっ|復元|保管/,
  delete_nodes: /削除|消し|消去|消す|削って/,
  diagnostic_scan: /スキャン|診断|矛盾|リスク|抜け|チェック|コメント/,
  set_title: /題名|タイトル|見出し/,
  list_nodes: /リスト|箇条書き|チェックリスト|書き出/,
  summarize_bullets: /箇条書き|要点|ポイント|まとめ|要約|サマリ|議事録/,
  resize_nodes: /大きく|小さく|でかく|サイズ|大きさ|拡大|縮小|倍/,
  stack_nodes: /重ね|スタック|積み|積んで|山/,
  unstack: /ばら|崩し|ほど|解除|重なり|広げ|展開/,
  find_duplicates: /重複|ダブり|かぶ|似て|同じ/,
  deadline_alert: /期限|締切|締め切り|遅れ|ヤバ|急ぎ|間近|超過/,
  arrange_view: /一覧|リスト|並べ|並び|順|グリッド|ソート|表示/,
  group_view: /ごと|別|グループ|カンバン|分類/,
  timeline_view: /時系列|週|月|日ごと|タイムライン|時期|古い|新しい|最近|時間|時刻|時間帯|朝|夜|午前|午後|記入|編集/,
  orbit_view: /軌道|重力|中心|同心円|関連度/,
  cluster_view: /テーマ|クラスタ|似た|意味|分類|グループ分け|仕分|整理/,
  matrix_view: /マトリクス|象限|緊急|重要|優先|仕分|2軸|二軸/,
  reset_view: /戻|解除|元の配置|自由配置|リセット/,
  report: /教えて|どれ|何|なぜ|要約|状況|まとめ|分析|ブリーフィング|今日|傾向|報告|[?？]/,
};

export function selectToolNames(command: string): string[] | null {
  const hit = toolNames().filter((n) => HINTS[n]?.test(command));
  if (hit.length === 0 || hit.length >= 14) return null;
  return [...new Set([...hit, 'report'])];
}

/** AIの「判断」が要る指令か。要らない単純な指令は軽いモデル・短い文脈で速く処理する */
const JUDGMENT_RE =
  /まとめ|要約|整理|分類|クラスタ|テーマ|マトリクス|優先|重要|緊急|関連|つな|繋|書き直|整えて|言い換|短く|ToDo|TODO|抽出|洗い出|広げ|アイデア出|発想|なぜ|教えて|どれ|どの|分析|矛盾|リスク|統合|重複|分解|分けて|似た|仕分|傾向|状況|提案|考えて|いつまで|[?？]/;
export const needsJudgment = (command: string) => JUDGMENT_RE.test(command);

export function buildToolCatalog(names?: string[] | null): string {
  const set = names ? new Set(names) : null;
  return ALL_TOOLS.filter((t) => !set || set.has(t.name))
    .map((t) => `- ${t.name}: ${t.description}\n    args_json: ${t.argsHint}`)
    .join('\n');
}
