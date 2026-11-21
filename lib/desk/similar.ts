import type { DeskNode } from './types';

/** 2文字ずつの集合の Jaccard 類似度（0〜1）。日本語でも空白区切りなしで使える、APIを使わない簡易判定 */
function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '').toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 先回り提案の下ごしらえ：新ノードに似た既存ノード上位k件（閾値未満は除外）。候補が無ければAIを呼ばない */
export function findSimilar(node: DeskNode, others: DeskNode[], k = 4, threshold = 0.18): DeskNode[] {
  return others
    .filter((o) => o.id !== node.id && !o.metadata?.archived)
    .map((o) => ({ o, s: similarity(node.content, o.content) }))
    .filter((x) => x.s >= threshold)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.o);
}

/**
 * 先回り提案の下ごしらえ：新ノードに「関係がありそうな」既存ノード上位k件。
 * 内容の近さに、同じカテゴリ・共通タグの加点を足す（閾値は低めにして、提案の機会を逃さない）。
 */
export function related(node: DeskNode, others: DeskNode[], k = 5, threshold = 0.08): DeskNode[] {
  const tagsOf = (n: DeskNode) => (Array.isArray(n.metadata?.tags) ? (n.metadata.tags as string[]) : []);
  const mine = new Set(tagsOf(node));
  return others
    .filter((o) => o.id !== node.id && !o.metadata?.archived)
    .map((o) => {
      let score = similarity(node.content, o.content);
      if (o.category === node.category) score += 0.1;
      score += 0.08 * tagsOf(o).filter((t) => mine.has(t)).length;
      return { o, score };
    })
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.o);
}
