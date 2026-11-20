import type { GoogleGenAI } from '@google/genai';

/*
 * Gemini のモデル名は世代交代で使えなくなる（404 NOT_FOUND）ことがある。
 * 固定名に頼らず、「動くモデルを自動で見つけて、動いた名前を覚える」ようにしている。
 *   1. 前回動いたモデル
 *   2. 環境変数 GEMINI_MODEL（軽量用は GEMINI_MODEL_LITE）
 *   3. エイリアス gemini-flash-latest / gemini-flash-lite-latest
 *   4. models.list() で見つかった Flash 系（新しい世代・通常版を優先）
 * 404 や「無料枠の上限が0」のモデルは飛ばして次を試す。それ以外のエラーはそのまま投げる。
 */

type Kind = 'standard' | 'lite';
const resolved: Partial<Record<Kind, string>> = {};

const isSkippable = (e: unknown) =>
  /404|NOT_FOUND|no longer available|is not found|limit:\s*0/i.test(String((e as any)?.message ?? e));

async function listFlashModels(ai: GoogleGenAI): Promise<{ name: string; lite: boolean }[]> {
  const found: { name: string; lite: boolean; v: number; preview: boolean }[] = [];
  try {
    const pager = await (ai as any).models.list();
    for await (const m of pager) {
      const name = String(m.name ?? '').replace(/^models\//, '');
      const mt = name.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview[\w.-]*)?$/);
      if (!mt) continue;
      if (Array.isArray(m.supportedActions) && !m.supportedActions.includes('generateContent')) continue;
      found.push({ name, lite: !!mt[2], v: parseFloat(mt[1]), preview: !!mt[3] });
    }
  } catch {
    /* 一覧が取れなくても、他の候補で続行する */
  }
  // 新しい世代を先に。同じ世代では正式版を先に
  found.sort((a, b) => b.v - a.v || Number(a.preview) - Number(b.preview));
  return found;
}

export async function generateWithFallback(
  ai: GoogleGenAI,
  req: { contents: string; config?: any },
  kind: Kind = 'standard'
) {
  const candidates: string[] = [];
  const add = (n?: string | null) => n && !candidates.includes(n) && candidates.push(n);
  add(resolved[kind]);
  add(kind === 'lite' ? process.env.GEMINI_MODEL_LITE || process.env.GEMINI_MODEL : process.env.GEMINI_MODEL);
  add(kind === 'lite' ? 'gemini-flash-lite-latest' : 'gemini-flash-latest');

  let listed = false;
  let lastErr: unknown;
  for (let i = 0; i < candidates.length && i < 8; i++) {
    const model = candidates[i];
    try {
      const res = await (ai as any).models.generateContent({ model, contents: req.contents, config: req.config });
      resolved[kind] = model;
      return res;
    } catch (e) {
      lastErr = e;
      if (!isSkippable(e)) throw e;
      if (i === candidates.length - 1 && !listed) {
        listed = true;
        const all = await listFlashModels(ai);
        const preferred = kind === 'lite' ? [...all.filter((m) => m.lite), ...all.filter((m) => !m.lite)] : [...all.filter((m) => !m.lite), ...all.filter((m) => m.lite)];
        preferred.forEach((m) => add(m.name));
      }
    }
  }
  throw new Error(
    `使えるGeminiモデルが見つかりませんでした（試した順: ${candidates.join(', ') || 'なし'}）。` +
      `AI Studio で使えるモデル名を確認し、環境変数 GEMINI_MODEL に設定してください。詳細: ${String((lastErr as any)?.message ?? lastErr).slice(0, 200)}`
  );
}
