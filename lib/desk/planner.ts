import { createHash } from 'crypto';
import { z } from 'zod';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { buildToolCatalog, getTool, needsJudgment, selectToolNames, toolNames } from './registry';
import { generateWithFallback } from './model';
import { nodeTags, toDay } from './selector';
import type { DeskNode, ExecutionPlan, PlanItem } from './types';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/* ------------------------------------------------------------------ */
/* ノード圧縮（短縮ID）                                                  */
/* ------------------------------------------------------------------ */

export interface CompressedNode {
  id: string;
  title: string;
  category: string;
  color: string;
  status: string;
  tags: string[];
  created: string;
  due?: string;
  stage?: string;
  pinned?: true;
  archived?: true;
  linked?: number; // つながっている線の本数
}

/** includeArchived=false（既定）のときはアーカイブ済みをAIに見せない（トークン節約） */
export function compressNodes(nodes: DeskNode[], opts: { includeArchived?: boolean } = {}) {
  const idMap = new Map<string, string>(); // n1 -> 実UUID
  const visible = nodes.filter((n) => opts.includeArchived || !n.metadata?.archived);
  const compressed: CompressedNode[] = visible.map((n, i) => {
    const id = `n${i + 1}`;
    idMap.set(id, n.id);
    const m = n.metadata ?? {};
    const links = Array.isArray(m.links) ? m.links.length : 0;
    return {
      id,
      title: n.content.replace(/\s+/g, ' ').slice(0, 70),
      category: n.category,
      color: n.color,
      status: n.status,
      tags: nodeTags(n),
      created: toDay(n.created_at),
      ...(typeof m.due === 'string' ? { due: m.due } : {}),
      ...(typeof m.stage === 'string' ? { stage: m.stage } : {}),
      ...(m.pinned ? { pinned: true as const } : {}),
      ...(m.archived ? { archived: true as const } : {}),
      ...(links ? { linked: links } : {}),
    };
  });
  return { compressed, idMap };
}

/**
 * AIに渡すノード一覧を、JSONではなく1行1ノードの短い形式にする（トークンが約半分になり、応答が速くなる）
 *   n3 [カテゴリ] タイトル #タグ due=2026-11-30 stage=進行中 col=amber st=scanned pin links=2 @2026-11-02
 * 既定値（色cyan・状態normal・タグがカテゴリだけ）は省く。作成日は日付に関係する指令のときだけ付ける。
 */
const DATE_WORDS = /作成|いつ|週|月|日|古|新し|最近|今日|昨日|時系列|タイムライン|時期|期間/;

export function formatNodes(nodes: CompressedNode[], command: string): string {
  const withDates = DATE_WORDS.test(command);
  return nodes
    .map((n) => {
      const parts = [`${n.id} [${n.category}] ${n.title}`];
      const extraTags = n.tags.filter((t) => t !== n.category);
      if (extraTags.length) parts.push(extraTags.map((t) => `#${t}`).join(' '));
      if (n.due) parts.push(`due=${n.due}`);
      if (n.stage) parts.push(`stage=${n.stage}`);
      if (n.color !== 'cyan') parts.push(`col=${n.color}`);
      if (n.status !== 'normal') parts.push(`st=${n.status}`);
      if (n.pinned) parts.push('pin');
      if (n.archived) parts.push('archived');
      if (n.linked) parts.push(`links=${n.linked}`);
      if (withDates) parts.push(`@${n.created}`);
      return parts.join(' ');
    })
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Gemini に渡すレスポンススキーマ                                       */
/* ------------------------------------------------------------------ */

const filterSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'いずれかに一致' },
    department: { type: Type.STRING, description: 'category と一致' },
    status: { type: Type.STRING },
    color: { type: Type.STRING },
    text: { type: Type.STRING, description: '本文に含まれる文字列' },
    createdWithinDays: { type: Type.INTEGER },
    createdAfter: { type: Type.STRING, description: 'YYYY-MM-DD' },
    createdBefore: { type: Type.STRING, description: 'YYYY-MM-DD' },
    stage: { type: Type.STRING },
    pinned: { type: Type.BOOLEAN },
    archived: { type: Type.BOOLEAN, description: 'trueでアーカイブ済みだけを対象にする' },
    dueWithinDays: { type: Type.INTEGER, description: '期限がN日以内（期限超過を含む）' },
    overdue: { type: Type.BOOLEAN },
    noDue: { type: Type.BOOLEAN },
    keyword: { type: Type.STRING, description: '本文・カテゴリ・タグのどれかに含まれる語。「〇〇に関するもの」はこれを使う' },
  },
};

const targetSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Current Nodes の短縮ID（n1, n2…）' },
    filter: filterSchema,
    all: { type: Type.BOOLEAN },
    fromPrevious: { type: Type.BOOLEAN },
  },
};

/**
 * args は「JSON文字列」で受け取る。
 * Gemini は properties 未定義のOBJECTを空 {} で返しがちなので、文字列で受けてZodで検証するほうが確実。
 */
const buildPlanSchema = (names: string[]): Schema => ({
  type: Type.OBJECT,
  properties: {
    message: { type: Type.STRING, description: 'HUDログバーに出す一言（日本語・20字程度）' },
    plan: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          tool: { type: Type.STRING, enum: names },
          target: targetSchema,
          args_json: { type: Type.STRING, description: 'ツール引数のJSON文字列。無ければ "{}"' },
        },
        required: ['tool', 'target', 'args_json'],
      },
    },
    unsupported: { type: Type.STRING, nullable: true },
    clarify: { type: Type.STRING, nullable: true },
  },
  required: ['message', 'plan'],
});

/* ------------------------------------------------------------------ */
/* 検証（Zod）                                                          */
/* ------------------------------------------------------------------ */

const filterZ = z.object({
  tags: z.array(z.string()).nullish(),
  department: z.string().nullish(),
  status: z.string().nullish(),
  color: z.string().nullish(),
  text: z.string().nullish(),
  createdWithinDays: z.number().nullish(),
  createdAfter: z.string().nullish(),
  createdBefore: z.string().nullish(),
  stage: z.string().nullish(),
  pinned: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  dueWithinDays: z.number().nullish(),
  overdue: z.boolean().nullish(),
  noDue: z.boolean().nullish(),
  keyword: z.string().nullish(),
});

const targetZ = z.object({
  ids: z.array(z.string()).nullish(),
  filter: filterZ.nullish(),
  all: z.boolean().nullish(),
  fromPrevious: z.boolean().nullish(),
});

const rawPlanZ = z.object({
  message: z.string().nullish(),
  plan: z.array(
    z.object({
      tool: z.string(),
      target: targetZ.nullish(),
      args_json: z.string().nullish(),
    })
  ),
  unsupported: z.string().nullish(),
  clarify: z.string().nullish(),
});

const EMPTY: ExecutionPlan = { message: '', plan: [], unsupported: null, clarify: null };

const issuesOf = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(', ');

export function parseAndValidate(text: string): { plan: ExecutionPlan; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { plan: EMPTY, errors: ['出力がJSONとして解析できません'] };
  }
  const parsed = rawPlanZ.safeParse(json);
  if (!parsed.success) return { plan: EMPTY, errors: [issuesOf(parsed.error)] };

  const errors: string[] = [];
  const items: PlanItem[] = [];
  parsed.data.plan.forEach((raw, i) => {
    const tool = getTool(raw.tool);
    if (!tool) {
      errors.push(`plan[${i}]: 未知のツール "${raw.tool}"（使えるのは ${toolNames().join(', ')}）`);
      return;
    }
    let argsObj: unknown = {};
    if (raw.args_json && raw.args_json.trim()) {
      try {
        argsObj = JSON.parse(raw.args_json) ?? {};
      } catch {
        errors.push(`plan[${i}] (${raw.tool}): args_json がJSONではありません`);
        return;
      }
    }
    const v = tool.argsSchema.safeParse(argsObj);
    if (!v.success) {
      errors.push(`plan[${i}] (${raw.tool}): ${issuesOf(v.error)}`);
      return;
    }
    items.push({ tool: raw.tool, target: raw.target ?? {}, args: v.data as Record<string, any> });
  });

  return {
    plan: {
      message: parsed.data.message ?? '',
      plan: items,
      unsupported: parsed.data.unsupported ?? null,
      clarify: parsed.data.clarify ?? null,
    },
    errors,
  };
}

/* ------------------------------------------------------------------ */
/* プロンプト                                                           */
/* ------------------------------------------------------------------ */

function buildPrompt(p: { command: string; brain: string; nodesText: string; today: string; toolNames: string[] | null }): string {
  // 共通部分（ツールカタログ・ルール）を先頭に置くと、暗黙キャッシュが効きやすい
  return `You are JARVIS, the executive AI of Mark1-desk.
You never edit data directly. You output an execution PLAN (JSON); deterministic code executes it. Be fast and terse.

=== TOOLS ===
${buildToolCatalog(p.toolNames)}

=== RULES ===
1. Use only node ids listed in Current Nodes (n1, n2, ...). Never invent ids.
2. PREFER target.filter / target.all over listing many ids. target.filter conditions are ANDed: keyword (matches content OR category OR tag — use it for "about X" / "related to X"), tags (any match), department (= category), status, color, stage, pinned, archived, text (substring of content), createdWithinDays, createdAfter/createdBefore (YYYY-MM-DD), dueWithinDays (includes overdue), overdue, noDue. Use target.ids only when you must pick nodes by judgement. target.all=true only when the user clearly means every node. target.fromPrevious=true reuses the nodes of the step executed just before (order: structure/rewrite > tagging/due/stage/links > node generation > zoom/color/pin/archive/delete/scan/alerts > view tools > report).
3. You may combine tools. View tools (arrange_view, group_view, timeline_view, orbit_view, cluster_view, matrix_view, reset_view) are mutually exclusive: at most ONE per plan.
4. For an order based on your judgement (importance, priority), use arrange_view sortBy="custom" with target.ids in the desired order.
5. Put tool arguments in args_json as a JSON string ("{}" if none). Do NOT use per-node lists (colorMap, assignments, ...) when one value / one filter is enough.
6. Write any text content yourself (merged text, split parts, summaries, comments) inside args. Keep it short, in the user's language.
7. If the command is ambiguous, return plan: [] and set clarify to ONE short question. If it cannot be done with the tools, return plan: [] and set unsupported.
8. message: one short HUD-style line in Japanese (about 20 characters).
9. Nodes may have due, stage, pin, links. Archived nodes are hidden unless the user asks about them; to restore use archive with restore=true and target.filter.archived=true.
10. For questions, summaries or status reports use the report tool; answer ONLY from Current Nodes.
11. Do not add tools the user did not ask for.

=== USER'S BRAIN VAULT (background knowledge & rules) ===
${p.brain}
=========================================================

Today: ${p.today} (Asia/Tokyo)
Current Nodes (one per line):
${p.nodesText}
User Command: ${JSON.stringify(p.command)}`;
}

/* ------------------------------------------------------------------ */
/* 呼び出し（リトライ＋キャッシュ）                                       */
/* ------------------------------------------------------------------ */

const isRetryable = (e: unknown) => /429|503|RESOURCE_EXHAUSTED|UNAVAILABLE/.test(String((e as any)?.message ?? e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(
  prompt: string,
  deadline: number,
  kind: 'standard' | 'lite',
  schema: Schema
): Promise<string> {
  // モデル名は model.ts が自動で見つけて覚える（404 のモデルは飛ばす）。時間制限つき
  const run = () =>
    generateWithFallback(
      ai,
      {
        contents: prompt,
        config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1, maxOutputTokens: 4096 },
      },
      kind,
      { deadline }
    );
  try {
    return (await run()).text ?? '';
  } catch (e) {
    if (!isRetryable(e) || deadline - Date.now() < 8000) throw e;
    await sleep(1500); // 一時的な混雑は1回だけ待って再試行
    return (await run()).text ?? '';
  }
}

// 同一インスタンス内の簡易キャッシュ（連打・再送対策）。Vercelでは効かないこともある
const cache = new Map<string, { at: number; plan: ExecutionPlan }>();
const TTL_MS = 60_000;

export async function createPlan(input: {
  command: string;
  brain: string;
  nodes: CompressedNode[];
}): Promise<{ plan: ExecutionPlan; warnings: string[]; cached: boolean }> {
  const deadline = Date.now() + 50_000; // 関数の実行時間上限（60秒）に収まるよう、AI待ちは合計50秒まで
  const { command } = input;
  const judgment = needsJudgment(command);
  const subset = selectToolNames(command); // null = 全ツール
  const nodesText = formatNodes(input.nodes, command);
  // 単純な指令は、保管庫（背景メモ）を短くして軽いモデルで速く処理する
  const brain = judgment ? input.brain : input.brain.slice(0, 1500);
  const today = toDay(new Date());

  const make = (names: string[] | null) => buildPrompt({ command, brain, nodesText, today, toolNames: names });
  const key = createHash('sha256').update(make(subset)).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { plan: structuredClone(hit.plan), warnings: [], cached: true };

  const run = async (names: string[] | null, kind: 'standard' | 'lite') => {
    const schema = buildPlanSchema(names ?? toolNames());
    let prompt = make(names);
    let result = { plan: EMPTY, errors: [] as string[] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await callGemini(prompt, deadline, kind, schema);
      result = parseAndValidate(text);
      if (result.errors.length === 0 || deadline - Date.now() < 15_000) break; // 残り時間が少ないなら、やり直さず今ある分を使う
      // 2回目は、前回の出力とエラーを見せて直させる
      prompt = `${make(names)}\n\n=== YOUR PREVIOUS OUTPUT WAS INVALID ===\n${text}\nErrors:\n- ${result.errors.join('\n- ')}\nReturn corrected JSON only.`;
    }
    return result;
  };

  let result = await run(subset, judgment ? 'standard' : 'lite');

  // ツールを絞ったせいで「できない」と返ってきたときだけ、全ツールで1回やり直す
  const gaveUp = result.plan.plan.length === 0 && !result.plan.clarify;
  if (subset && gaveUp && deadline - Date.now() > 18_000) result = await run(null, 'standard');

  if (result.errors.length === 0) {
    if (cache.size > 50) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), plan: structuredClone(result.plan) });
  }
  // エラーが残っても、検証を通ったステップだけは実行する
  return { plan: result.plan, warnings: result.errors, cached: false };
}

/* ------------------------------------------------------------------ */
/* 保存済みプラン（マクロ）の検証・再実行可否                              */
/* ------------------------------------------------------------------ */

const storedPlanZ = z.object({
  message: z.string().nullish(),
  plan: z.array(z.object({ tool: z.string(), target: targetZ.nullish(), args: z.any() })),
});

export function validateExecutionPlan(input: unknown): { plan: ExecutionPlan; errors: string[] } {
  const parsed = storedPlanZ.safeParse(input);
  if (!parsed.success) return { plan: EMPTY, errors: [issuesOf(parsed.error)] };
  const errors: string[] = [];
  const items: PlanItem[] = [];
  parsed.data.plan.forEach((raw, i) => {
    const tool = getTool(raw.tool);
    if (!tool) return void errors.push(`plan[${i}]: 未知のツール "${raw.tool}"`);
    const v = tool.argsSchema.safeParse(raw.args ?? {});
    if (!v.success) return void errors.push(`plan[${i}] (${raw.tool}): ${issuesOf(v.error)}`);
    items.push({ tool: raw.tool, target: raw.target ?? {}, args: v.data as Record<string, any> });
  });
  return { plan: { message: parsed.data.message ?? '', plan: items, unsupported: null, clarify: null }, errors };
}

const ID_KEY_RE = /"(id|ids|centerId|sourceId|from|to|hub)"\s*:/;

/** 個別ノードIDや生成済みの文面を含まない（＝条件だけで再実行できる）プランか */
export function isReplayable(plan: ExecutionPlan): boolean {
  return (
    plan.plan.length > 0 &&
    plan.plan.every((it) => {
      const tool = getTool(it.tool);
      return !!tool && tool.replayable !== false && !it.target?.ids?.length && !ID_KEY_RE.test(JSON.stringify(it.args ?? {}));
    })
  );
}

/* ------------------------------------------------------------------ */
/* 先回り提案（autonomous_whisper）                                      */
/* ------------------------------------------------------------------ */

const whisperSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          message: { type: Type.STRING, description: '提案の一言（日本語・40字以内）' },
          command: { type: Type.STRING, description: 'そのまま実行できる自然文の指令（日本語）' },
        },
        required: ['message', 'command'],
      },
    },
  },
  required: ['suggestions'],
};

export async function createWhisper(input: {
  node: CompressedNode;
  related: CompressedNode[];
  brain: string;
  today: string;
}): Promise<{ message: string; command: string }[]> {
  const prompt = `You are JARVIS. The user just added a new node to their thinking desk. Proactively suggest up to 3 genuinely useful follow-up actions about it. Be concrete and specific; skip generic advice. Return [] if nothing is clearly worthwhile.
Good suggestion types: merge with a near-duplicate; link related nodes; set a due date (when the text implies one, compute it from today); turn it into a to-do / set stage; split a multi-idea node; add useful tags; notice a contradiction or missing premise with a related node; propose a next step.
- message: one short Japanese line in JARVIS style (e.g. "サー、〇〇と統合可能です").
- command: a natural-language Japanese command that can be run as-is. Refer to nodes by their content in 「」, NEVER by ids.

=== USER'S BRAIN VAULT ===
${input.brain.slice(0, 1500)}
==========================
Today: ${input.today}
New node: ${formatNodes([input.node], '')}
Related existing nodes:
${formatNodes(input.related, '') || '(none)'}`;

  const res = await generateWithFallback(
    ai,
    { contents: prompt, config: { responseMimeType: 'application/json', responseSchema: whisperSchema, temperature: 0.3, maxOutputTokens: 1024 } },
    'lite',
    { deadline: Date.now() + 25_000, perCallMs: 20_000 }
  );
  try {
    const j = JSON.parse(res.text ?? '{}');
    return (Array.isArray(j.suggestions) ? j.suggestions : [])
      .filter((x: any) => typeof x?.message === 'string' && typeof x?.command === 'string' && x.message.trim() && x.command.trim())
      .slice(0, 3)
      .map((x: any) => ({ message: x.message.trim(), command: x.command.trim() }));
  } catch {
    return [];
  }
}
