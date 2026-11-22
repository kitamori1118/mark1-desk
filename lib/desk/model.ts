import type { GoogleGenAI } from '@google/genai';

/*
 * Gemini のモデル名は世代交代で使えなくなる（404 NOT_FOUND）ことがある。
 * 固定名に頼らず、「動くモデルを自動で見つけて、動いた名前を覚える」ようにしている。
 *   1. 前回動いたモデル
 *   2. 環境変数 GEMINI_MODEL（軽量用は GEMINI_MODEL_LITE）
 *   3. エイリアス gemini-flash-latest / gemini-flash-lite-latest
 *   4. models.list() で見つかった Flash 系（新しい世代・通常版を優先）
 * 404 や「無料枠の上限が0」のモデルは飛ばして次を試す。それ以外のエラーはそのまま投げる。
 *
 * また、応答が返ってこないまま画面が止まらないよう、1回ごとに時間制限をかけ、全体の締め切りも守る。
 */

type Kind = 'standard' | 'lite';
const resolved: Partial<Record<Kind, string>> = {};

/** 今使っているモデル名（画面の表示・デバッグ用） */
export const getResolvedModel = (kind: Kind = 'standard') => resolved[kind] ?? null;

const isSkippable = (e: unknown) =>
  /404|NOT_FOUND|no longer available|is not found|limit:\s*0/i.test(String((e as any)?.message ?? e));

/** 画面側の「中断」で待つのをやめる（通信自体は止められなくても、結果は使わない） */
const abortable = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> =>
  !signal
    ? p
    : new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error('中断されました'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(
          (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          }
        );
      });

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} が ${Math.round(ms / 1000)} 秒以内に応答しませんでした`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

async function listFlashModels(ai: GoogleGenAI): Promise<{ name: string; lite: boolean }[]> {
  const found: { name: string; lite: boolean; v: number; preview: boolean }[] = [];
  try {
    const pager: any = await withTimeout((ai as any).models.list(), 8000, 'モデル一覧の取得');
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

/**
 * 考える量を抑えて速くする（プラン作成は複雑な推論が不要）。
 * モデルの世代によって指定の仕方が違う（3系は thinkingLevel、2.5系は thinkingBudget）ので、
 * 受け付けられた指定を覚えておき、無理なら設定なしにやり直す。
 */
const thinkingChoice = new Map<string, number>(); // モデル名 → 使えた指定の番号
const thinkingVariants = (model: string): (Record<string, unknown> | null)[] =>
  /gemini-3/.test(model)
    ? [{ thinkingLevel: 'LOW' }, { thinkingBudget: 0 }, null]
    : [{ thinkingBudget: 0 }, null];

async function callOnce(ai: GoogleGenAI, model: string, req: { contents: string; config?: any }) {
  const variants = thinkingVariants(model);
  const call = (thinking: Record<string, unknown> | null) =>
    (ai as any).models.generateContent({
      model,
      contents: req.contents,
      config: thinking ? { ...req.config, thinkingConfig: thinking } : req.config,
    });
  for (let i = thinkingChoice.get(model) ?? 0; i < variants.length; i++) {
    try {
      const res = await call(variants[i]);
      thinkingChoice.set(model, i);
      return res;
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      const thinkingProblem = /thinking/i.test(msg) && /400|INVALID_ARGUMENT/i.test(msg);
      if (!thinkingProblem || i === variants.length - 1) throw e;
    }
  }
}

export async function generateWithFallback(
  ai: GoogleGenAI,
  req: { contents: string; config?: any },
  kind: Kind = 'standard',
  opts: { deadline?: number; perCallMs?: number; signal?: AbortSignal } = {}
) {
  const candidates: string[] = [];
  const add = (n?: string | null) => n && !candidates.includes(n) && candidates.push(n);
  add(resolved[kind]);
  add(kind === 'lite' ? process.env.GEMINI_MODEL_LITE || process.env.GEMINI_MODEL : process.env.GEMINI_MODEL);
  add(kind === 'lite' ? 'gemini-flash-lite-latest' : 'gemini-flash-latest');

  const remaining = () => (opts.deadline ?? Infinity) - Date.now();
  let listed = false;
  let lastErr: unknown;
  for (let i = 0; i < candidates.length && i < 8; i++) {
    const model = candidates[i];
    if (opts.signal?.aborted) throw new Error('中断されました');
    if (remaining() < 3000) throw new Error('時間切れ: AIの応答待ちが長引いたため中止しました。もう一度お試しください');
    try {
      const res = await withTimeout(
        abortable(callOnce(ai, model, req), opts.signal),
        Math.min(opts.perCallMs ?? 40_000, remaining()),
        `モデル ${model}`
      );
      resolved[kind] = model;
      return res;
    } catch (e) {
      lastErr = e;
      if (!isSkippable(e)) throw e;
      if (i === candidates.length - 1 && !listed) {
        listed = true;
        const all = await listFlashModels(ai);
        const preferred =
          kind === 'lite'
            ? [...all.filter((m) => m.lite), ...all.filter((m) => !m.lite)]
            : [...all.filter((m) => !m.lite), ...all.filter((m) => m.lite)];
        preferred.forEach((m) => add(m.name));
      }
    }
  }
  throw new Error(
    `使えるGeminiモデルが見つかりませんでした（試した順: ${candidates.join(', ') || 'なし'}）。` +
      `AI Studio で使えるモデル名を確認し、環境変数 GEMINI_MODEL に設定してください。詳細: ${String((lastErr as any)?.message ?? lastErr).slice(0, 200)}`
  );
}
