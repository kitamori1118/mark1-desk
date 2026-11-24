/*
 * 画面の見え方（カメラ）に関する指令を、端末側だけで解釈する（サーバーに送らない＝即時・無料）。
 *   拡大／縮小／○○%／画面に収める／表示のリセット／上下左右への移動／オーブ全体の大きさ
 * 「タスクを大きくして」のように対象を指定したものは、データ（個別の大きさ）を変えるのでサーバー側の指令になる。
 */

export type ViewAction =
  | { type: 'zoom'; mode: 'in' | 'out'; factor: number }
  | { type: 'zoom'; mode: 'set'; value: number } // 1 = 等倍
  | { type: 'zoom'; mode: 'fit' }
  | { type: 'zoom'; mode: 'reset'; clearView: boolean }
  | { type: 'pan'; dir: 'up' | 'down' | 'left' | 'right'; pages: number }
  | { type: 'goto'; where: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'origin' }
  | { type: 'orbSize'; mode: 'up' | 'down' | 'reset' | 'set'; value?: number };

const POLITE = /(して(ください|くれ|ほしい)?|してね|してよ|ください|くれ|お願い(します)?)$/;

const amount = (c: string, small: number, normal: number, big: number) =>
  /(もっと|さらに|ぐっと|大きく)/.test(c) ? big : /(少し|ちょっと|ほんの)/.test(c) ? small : normal;

export function parseViewCommand(raw: string): ViewAction | null {
  const c = raw.trim().replace(/[。.!！\s]+$/g, '').replace(POLITE, '').replace(/\s+/g, '');
  if (!c || c.length > 30) return null;

  // 画面に収める
  if (/(収め|収まる|収まるよう|フィット)|全体(を)?(表示|見せ|見える)|(全部|すべて|全て)(を)?(見せ|見える|表示)|全体が見える|画面(いっぱい|に合わせ)/.test(c)) {
    return { type: 'zoom', mode: 'fit' };
  }

  // 表示のリセット（整列も解除する）／ズームだけリセット
  if (/(表示画面|表示|画面|ビュー|視点|カメラ)(を)?(リセット|元に戻|初期化|初期状態|デフォルト)|^(リセット|初期表示)$/.test(c)) {
    return { type: 'zoom', mode: 'reset', clearView: true };
  }
  if (/(ズーム|倍率|拡大率)(を)?(リセット|元に戻|100%|等倍|初期)|^等倍(に戻(す)?)?$/.test(c)) return { type: 'zoom', mode: 'reset', clearView: false };

  // ○○%／N倍 に拡大・縮小
  let m = c.match(/(?:表示|ズーム|倍率|拡大率|画面).{0,4}?(\d{2,3})[%％]/) || c.match(/(\d{2,3})[%％](?:に|で)?(?:拡大|縮小|ズーム|表示)/);
  if (m) return { type: 'zoom', mode: 'set', value: Math.min(Math.max(Number(m[1]) / 100, 0.1), 3) };
  m = c.match(/(\d+(?:\.\d+)?)倍(?:に|で)?(?:拡大|ズーム|表示)/);
  if (m) return { type: 'zoom', mode: 'set', value: Math.min(Math.max(Number(m[1]), 0.1), 3) };

  // 拡大／縮小（対象を言わない、画面全体の操作だけ）
  if (/^(画面|表示|全体|ビュー|キャンバス|マップ)?(を|の)?(もっと|少し|ちょっと|さらに)?(拡大|ズームイン|寄って|アップ|近づけ|近づいて|大きく表示)$/.test(c)) {
    return { type: 'zoom', mode: 'in', factor: amount(c, 1.12, 1.25, 1.6) };
  }
  if (/^(画面|表示|全体|ビュー|キャンバス|マップ)?(を|の)?(もっと|少し|ちょっと|さらに)?(縮小|ズームアウト|引いて|引き|遠ざけ|離れて|俯瞰|小さく表示)$/.test(c)) {
    return { type: 'zoom', mode: 'out', factor: 1 / amount(c, 1.12, 1.25, 1.6) };
  }

  // 上下左右へ移動（「下がって」「もっと右」など）
  m = c.match(/^(もっと|少し|ちょっと)?(上|下|左|右)(?:の方)?(?:へ|に)?(?:移動|スクロール|動か|動い|進ん|進|ずら|行っ|行|見せ|が(?:っ)?)?(?:し|て|る)?$/);
  if (m) {
    const dir = ({ 上: 'up', 下: 'down', 左: 'left', 右: 'right' } as const)[m[2] as '上' | '下' | '左' | '右'];
    return { type: 'pan', dir, pages: amount(c, 0.3, 0.6, 1) };
  }

  // 端・中央へ
  if (/(一番|いちばん|最も)(上|下|左|右)|最上部|最下部|(先頭|トップ)(へ|に)?(戻|移動)?$|(中央|真ん中|中心)(へ|に)?(戻|移動|寄|見せ)?$|(左上|原点)(へ|に)?(戻|移動)?$/.test(c)) {
    const w = /(一番|いちばん|最も)上|最上部|先頭|トップ/.test(c)
      ? 'top'
      : /(一番|いちばん|最も)下|最下部/.test(c)
      ? 'bottom'
      : /(一番|いちばん|最も)左/.test(c)
      ? 'left'
      : /(一番|いちばん|最も)右/.test(c)
      ? 'right'
      : /(中央|真ん中|中心)/.test(c)
      ? 'center'
      : 'origin';
    return { type: 'goto', where: w };
  }

  // オーブ全体の大きさ（対象を言わないとき）
  const subj = '(オーブ|ノード|メモ|全部|すべて|全て|全体)';
  if (new RegExp(`^${subj}?(の)?(サイズ|大きさ)?(を)?(もっと|少し|ちょっと)?(大きく|でかく)$`).test(c) && new RegExp(`${subj}|サイズ|大きさ`).test(c)) {
    return { type: 'orbSize', mode: 'up' };
  }
  if (new RegExp(`^${subj}?(の)?(サイズ|大きさ)?(を)?(もっと|少し|ちょっと)?(小さく|ちいさく)$`).test(c) && new RegExp(`${subj}|サイズ|大きさ`).test(c)) {
    return { type: 'orbSize', mode: 'down' };
  }
  if (new RegExp(`^${subj}?(の)?(サイズ|大きさ)(を)?(標準|普通|デフォルト|元)(に)?(戻)?$`).test(c) || /^(標準|普通|デフォルト|元)(の)?(サイズ|大きさ)(に戻(す)?|に)?$/.test(c)) {
    return { type: 'orbSize', mode: 'reset' };
  }
  m = c.match(new RegExp(`^${subj}?(?:の)?(?:サイズ|大きさ)(?:を)?(\\d{2,3})[%％]$`));
  if (m) return { type: 'orbSize', mode: 'set', value: Math.min(Math.max(Number(m[m.length - 1]) / 100, 0.4), 2) };

  return null;
}
