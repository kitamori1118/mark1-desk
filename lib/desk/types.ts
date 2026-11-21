import type { z, ZodTypeAny } from 'zod';

export const DESK_COLORS = ['cyan', 'amber', 'crimson', 'emerald'] as const;
export type DeskColor = (typeof DESK_COLORS)[number];

/** stark_nodes の1行（metadata は必ずオブジェクトに正規化して扱う） */
export interface DeskNode {
  id: string;
  content: string;
  category: string;
  color: string;
  status: string;
  metadata: Record<string, any>;
  created_at: string;
}

/** 絞り込み条件。指定した条件は AND で結合される */
export interface NodeFilter {
  tags?: string[] | null; // いずれかのタグに一致（OR）
  department?: string | null; // category と一致
  status?: string | null;
  color?: string | null;
  text?: string | null; // 本文に含まれる文字列
  createdWithinDays?: number | null;
  createdAfter?: string | null; // YYYY-MM-DD（日本時間）
  createdBefore?: string | null; // YYYY-MM-DD（日本時間）
  stage?: string | null; // metadata.stage（未着手 / 進行中 / 完了 など）
  pinned?: boolean | null;
  archived?: boolean | null; // true = アーカイブ済みだけを対象にする（既定は除外）
  dueWithinDays?: number | null; // 期限が N 日以内（期限超過も含む）
  overdue?: boolean | null; // 期限超過のみ
  noDue?: boolean | null; // 期限なしのみ
  keyword?: string | null; // 本文・カテゴリ・タグのどれかに含まれる（「〇〇に関するもの」）
}

/** ツールの対象指定 */
export interface TargetSelector {
  ids?: string[] | null; // 短縮ID(n1..) または実ID。並び順は保持される
  filter?: NodeFilter | null;
  all?: boolean | null; // 全ノード
  fromPrevious?: boolean | null; // 直前に実行したステップと同じ対象
}

export interface PlanItem {
  tool: string;
  target: TargetSelector;
  args: Record<string, any>;
}

export interface ExecutionPlan {
  message: string;
  plan: PlanItem[];
  unsupported?: string | null;
  clarify?: string | null;
}

/* ---------- 表示（ビュー）指令：DBは変えず、クライアントに「こう並べて」と伝える ---------- */

export type ViewLayout = 'free' | 'list' | 'grid' | 'columns' | 'kanban' | 'matrix' | 'timeline' | 'orbit';

export interface ViewGroup {
  key: string;
  label: string;
  ids: string[];
}

export interface ViewDirective {
  layout: ViewLayout;
  title?: string;
  /** 表示対象ノードIDを表示順に並べたもの */
  order: string[];
  /** columns / timeline / orbit で使うグループ（セクション） */
  groups?: ViewGroup[];
  /** 表示対象外（クライアント側で淡くする or 隠す） */
  hiddenIds: string[];
  /** orbit の中心ノード */
  centerId?: string;
}

/* ---------- ツール実行コンテキスト ---------- */

export interface NodePatch {
  content?: string;
  category?: string;
  color?: string;
  status?: string;
  /** 既存 metadata にマージされる。値が null / undefined のキーは削除される */
  metadata?: Record<string, any>;
}

export interface NewNode {
  content: string;
  category?: string;
  color?: string;
  status?: string;
  metadata?: Record<string, any>;
}

export interface ToolContext {
  /** 現在のノード一覧（書き込みのたびに更新される） */
  nodes: DeskNode[];
  /** 直前に実行したステップの対象ID（fromPrevious 用） */
  lastTargetIds: string[];
  /** レイアウト系ツールがセットする表示指令（1回の指令につき1つだけ） */
  view: ViewDirective | null;
  today: Date;
  /** report ツールが積む「AIからの回答」テキスト */
  reports: string[];
  /** 短縮ID(n1) → 実ID。存在しないIDは null */
  realId(id: string): string | null;
  patchNodes(ids: string[], patch: NodePatch): Promise<void>;
  insertNodes(rows: NewNode[]): Promise<DeskNode[]>;
  deleteNodes(ids: string[]): Promise<void>;
}

/* ---------- ツール定義 ---------- */

export interface ToolDef {
  name: string;
  /** 小さいほど先に実行。構造系 < 付与系 < 見た目系 < スキャン < レイアウト系 */
  phase: number;
  /** プロンプトのカタログに載る説明（いつ使うか） */
  description: string;
  /** プロンプトのカタログに載る args_json の説明 */
  argsHint: string;
  /** 対象未指定のとき: 'all' = 全ノード / 'none' = 何もしない */
  defaultTarget: 'all' | 'none';
  argsSchema: ZodTypeAny;
  /** false のツールは、マクロ（AIを介さない再実行）として保存できない。既定 true */
  replayable?: boolean;
  run(ctx: ToolContext, targets: DeskNode[], args: any): Promise<string>;
}

/** argsSchema から run の args 型が推論されるようにするヘルパー */
export function defineTool<S extends ZodTypeAny>(def: {
  name: string;
  phase: number;
  description: string;
  argsHint: string;
  defaultTarget: 'all' | 'none';
  argsSchema: S;
  replayable?: boolean;
  run: (ctx: ToolContext, targets: DeskNode[], args: z.infer<S>) => Promise<string>;
}): ToolDef {
  return def as unknown as ToolDef;
}
