/**
 * 依赖列解析（ADR 0006 §4/§7）：语法 `编号[FS|SS|FF|SF][±lag]`，分号分隔多前置。
 *
 * **成环边丢弃必须确定性，且不得用 `compute` 兜底**（ADR 0006 §7 / 裁决 P-14 第 4 条）：
 * 解析出的全部边按「**工作表行序 × 单元格内前置出现顺序**」逐条处理，
 * 对每条候选先调 `wouldCreateCycle(已接受的边, 候选)`；`cyclic === true` → 丢弃 + `XLSX_CYCLE_EDGE_DROPPED`
 * （消息里带 `path`），否则接受。**丢弃后不回插、不做回溯**——丢弃顺序若不确定，
 * "自往返一致"会变成偶发失败。
 */
import { wouldCreateCycle, type DocumentLink, type LinkType } from '@ganttpilot/engine';

import type { ColumnKey } from './columns.js';
import type { Reporter } from './values.js';

/** 分号：半角与**全角**都接受（ADR 0006 §4）。 */
export const DEPENDENCY_SEPARATOR = /[;；]/;

const TOKEN_PATTERN = /^([^[\]]*?)(?:\[([^\]]*)\])?$/;

interface RawToken {
  /** 编号（原样，未 trim 之外的处理）。 */
  readonly number: string;
  readonly typeText: string | null;
  readonly lagText: string | null;
}

/** 把单元格文本切成片段（**空片段容忍**：`1;;2` 与结尾分号都不报错）。 */
export function splitDependencyCell(text: string): readonly RawToken[] {
  return text
    .split(DEPENDENCY_SEPARATOR)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .map((piece) => {
      const match = TOKEN_PATTERN.exec(piece);
      const number = (match?.[1] ?? piece).trim();
      const bracket = match?.[2];
      let typeText: string | null = null;
      let lagText: string | null = null;
      if (bracket !== undefined) {
        const compact = bracket.replace(/\s+/g, '').toUpperCase();
        const typeMatch = /^(FS|SS|FF|SF)/.exec(compact);
        if (typeMatch !== null) {
          typeText = typeMatch[1] ?? null;
          lagText = compact.slice(typeMatch[0].length);
        } else {
          // `[+3]` 这种只写 lag 的形态：类型省略、默认 FS
          lagText = compact;
        }
        if (lagText === '') {
          lagText = null;
        }
      }
      return { number, typeText, lagText };
    });
}

/** 单个片段解析结果。 */
export type DependencyTokenResult =
  | { readonly ok: true; readonly number: string; readonly type: LinkType; readonly lagDays: number }
  | { readonly ok: false; readonly reason: string };

/** 解析单个片段（不做"编号是否存在"的判断——那需要整张表）。 */
export function parseDependencyToken(token: RawToken): DependencyTokenResult {
  if (token.number === '') {
    return { ok: false, reason: '缺少前置任务编号' };
  }
  let type: LinkType = 'FS';
  if (token.typeText !== null) {
    if (token.typeText === 'FS' || token.typeText === 'SS' || token.typeText === 'FF' || token.typeText === 'SF') {
      type = token.typeText;
    } else {
      return { ok: false, reason: `未知关系类型：${token.typeText}` };
    }
  }
  let lagDays = 0;
  if (token.lagText !== null) {
    if (!/^[-+]?\d+$/.test(token.lagText)) {
      return { ok: false, reason: `lag 不是整数：${token.lagText}` };
    }
    lagDays = Number(token.lagText);
  }
  return { ok: true, number: token.number, type, lagDays };
}

/** 一条待解析的边（"工作表行序 × 单元格内顺序"由此数组的**元素序**承载）。 */
export interface CandidateEdge {
  /** 前置任务编号（工作表里写的那个）。 */
  readonly fromNumber: string;
  /** 后置任务编号（工作表里写的那个）。 */
  readonly toNumber: string;
  readonly type: LinkType;
  readonly lagDays: number;
}

/** 边解析结论。 */
export interface ResolvedEdges {
  readonly links: readonly DocumentLink[];
  /** 因成环被丢弃的边数（与 `XLSX_CYCLE_EDGE_DROPPED` 条数同数）。 */
  readonly droppedCycles: number;
}

export interface ResolveEdgesInput {
  /** **顺序即裁决顺序**，调用方必须按「工作表行序 × 单元格内前置出现顺序」构造。 */
  readonly candidates: readonly CandidateEdge[];
  /** 工作表编号 → 任务 id。 */
  readonly taskIdOfNumber: ReadonlyMap<string, string>;
  readonly suggestLinkId: () => string;
  readonly reporter: Reporter;
  readonly column: ColumnKey;
}

/**
 * 逐条裁决候选边：查重 → 自环 → 成环 → 接受。
 *
 * 顺序**不可交换**：先判自环与重复（它们与已有边集合无关），再用 `wouldCreateCycle` 判环，
 * 这样才能保证"丢弃哪一条"只取决于文档序与单元格内顺序。
 */
export function resolveEdges(input: ResolveEdgesInput): ResolvedEdges {
  const links: DocumentLink[] = [];
  const seen = new Set<string>();
  let droppedCycles = 0;

  for (const candidate of input.candidates) {
    const fromId = input.taskIdOfNumber.get(candidate.fromNumber);
    const toId = input.taskIdOfNumber.get(candidate.toNumber);
    if (fromId === undefined || toId === undefined) {
      // 编号未知在解析阶段已报 `XLSX_DEPENDENCY_UNPARSABLE`；这里只做防御性跳过
      continue;
    }

    if (fromId === toId) {
      input.reporter('XLSX_DEPENDENCY_SELF_LOOP', `依赖指向自身：${candidate.fromNumber}`, {
        column: input.column,
        taskId: toId,
      });
      continue;
    }

    const dedupeKey = `${fromId}|${toId}|${candidate.type}`;
    if (seen.has(dedupeKey)) {
      input.reporter(
        'XLSX_DEPENDENCY_DUPLICATE',
        `重复的前置任务（同 from/to/type，只保留首条）：${candidate.fromNumber}`,
        { column: input.column, taskId: toId },
      );
      continue;
    }

    const link: DocumentLink = {
      id: input.suggestLinkId(),
      from: fromId,
      to: toId,
      type: candidate.type,
      lagDays: candidate.lagDays,
    };
    const cycle = wouldCreateCycle(links, link);
    if (cycle.cyclic) {
      droppedCycles += 1;
      input.reporter(
        'XLSX_CYCLE_EDGE_DROPPED',
        `该前置会造成循环依赖，已丢弃：${candidate.fromNumber} → ${candidate.toNumber}（成环路径 ${cycle.path.join(' → ')}）`,
        { column: input.column, taskId: toId },
      );
      continue;
    }

    seen.add(dedupeKey);
    links.push(link);
  }

  return { links, droppedCycles };
}
