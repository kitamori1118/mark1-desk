import type { ToolDef } from './types';
import { ALL_TOOLS } from './tools';

const map = new Map<string, ToolDef>(ALL_TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string): ToolDef | undefined => map.get(name);

export const toolNames = (): string[] => [...map.keys()];

/** プロンプトに差し込むツールカタログ（各ツールの description / argsHint から自動生成） */
export function buildToolCatalog(): string {
  return ALL_TOOLS.map((t) => `- ${t.name}: ${t.description}\n    args_json: ${t.argsHint}`).join('\n');
}
