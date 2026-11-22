import type { ToolDef } from '../types';
import { autoTag, diagnosticScan, spectrumShift, zoom } from './basic';
import { crystallizeCore, mergeDuplicates, splitNode } from './structure';
import { arrangeView, clusterView, groupView, matrixView, orbitView, resetView, timelineView } from './view';
import { linkNodes, unlinkNodes } from './links';
import { archiveNodes, deadlineAlert, deleteNodes, findDuplicates, pinNodes, setDue, setStage } from './meta';
import { stackNodes, unstackNodes } from './stack';
import { expandIdeas, extractActions, report, rewriteNode } from './ai';

/**
 * 新しい機能を足すときは、tools/ に defineTool() で1つ書いて、ここに1行足すだけ。
 * プロンプトのカタログ・Geminiのtool enum・Zod検証・実行順（phase）は全部ここから自動で決まる。
 */
export const ALL_TOOLS: ToolDef[] = [
  // 構造・書き換え
  mergeDuplicates,
  rewriteNode,
  splitNode,
  // 付与（タグ・期限・ステージ・線）
  autoTag,
  setDue,
  setStage,
  linkNodes,
  unlinkNodes,
  // AIが新しいノードを生む
  crystallizeCore,
  extractActions,
  expandIdeas,
  // 見た目・状態
  zoom,
  spectrumShift,
  pinNodes,
  archiveNodes,
  deleteNodes,
  stackNodes,
  unstackNodes,
  diagnosticScan,
  deadlineAlert,
  findDuplicates,
  // 整列表示（1回の指令に1つだけ）
  arrangeView,
  groupView,
  timelineView,
  orbitView,
  clusterView,
  matrixView,
  resetView,
  // 回答
  report,
].sort((a, b) => a.phase - b.phase);
