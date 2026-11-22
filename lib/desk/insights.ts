import type { DeskNode } from './types';
import { daysUntil, dueOf, isArchived } from './selector';
import { similarity } from './similar';

/*
 * 先回り提案のうち「AIを使わず、その場で出せるもの」。画面側で即時に計算する（0コスト）。
 * 実行を押したときの指令は、サーバー側の高速パス（AIなし）か、AIが処理する。
 */

export interface Suggestion {
  id: string;
  source: 'local' | 'ai';
  message: string;
  command: string;
}

const short = (s: string, n = 14) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const DATE_RE = /(\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|明日|明後日|来週|今週|今月|来月|今日中|までに|まで|締切|締め切り|期限)/;
const ACTION_RE = /(する|やる|確認|連絡|提出|送る|送付|作る|作成|予約|買う|購入|調べる|調査|準備|依頼|対応|相談|検討)(こと|必要|予定|しなきゃ|しないと)?/;

/** ノードを追加した直後に出す提案（重複・期限・やること） */
export function suggestionsForNewNode(node: DeskNode, others: DeskNode[]): Suggestion[] {
  const out: Suggestion[] = [];
  const live = others.filter((o) => o.id !== node.id && !isArchived(o));

  const dup = live.map((o) => ({ o, s: similarity(node.content, o.content) })).sort((a, b) => b.s - a.s)[0];
  if (dup && dup.s >= 0.45) {
    out.push({
      id: `dup:${node.id}:${dup.o.id}`,
      source: 'local',
      message: `サー、「${short(dup.o.content)}」と内容が近いです。統合しますか？`,
      command: `「${short(node.content, 20)}」と「${short(dup.o.content, 20)}」を統合して`,
    });
  }
  if (DATE_RE.test(node.content) && !dueOf(node)) {
    out.push({
      id: `due:${node.id}`,
      source: 'local',
      message: '期限らしき表現があります。期限を設定しますか？',
      command: `「${short(node.content, 20)}」の期限を設定して`,
    });
  }
  if (ACTION_RE.test(node.content) && !node.metadata?.stage) {
    out.push({
      id: `todo:${node.id}`,
      source: 'local',
      message: 'やるべきことのようです。未着手のタスクにしますか？',
      command: `「${short(node.content, 20)}」を未着手にして`,
    });
  }
  return out;
}

/** 開いているときに常に見張る提案（期限切れ・重複の疑い） */
// now は呼び出し側から渡す（描画中に new Date() を読むと Next.js のプリレンダーでエラーになるため）
export function overviewSuggestions(nodes: DeskNode[], now: Date): Suggestion[] {
  const live = nodes.filter((n) => !isArchived(n));
  const out: Suggestion[] = [];

  let overdue = 0;
  let soon = 0;
  for (const n of live) {
    const due = dueOf(n);
    if (!due || n.metadata?.stage === '完了') continue;
    const left = daysUntil(due, now);
    if (Number.isNaN(left)) continue;
    if (left < 0) overdue++;
    else if (left <= 3) soon++;
  }
  if (overdue || soon) {
    out.push({
      id: `due:${overdue}:${soon}`,
      source: 'local',
      message: `期限超過${overdue}件・3日以内${soon}件があります`,
      command: '期限が近いものを警告して',
    });
  }

  if (live.length <= 150) {
    let best: { a: DeskNode; b: DeskNode; s: number } | null = null;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const s = similarity(live[i].content, live[j].content);
        if (s >= 0.6 && (!best || s > best.s)) best = { a: live[i], b: live[j], s };
      }
    }
    if (best) {
      out.push({
        id: `dup:${best.a.id}:${best.b.id}`,
        source: 'local',
        message: `「${short(best.a.content)}」と「${short(best.b.content)}」は重複の可能性があります`,
        command: `「${short(best.a.content, 20)}」と「${short(best.b.content, 20)}」を統合して`,
      });
    }
  }
  return out;
}
