/**
 * G4 的**声明式期望值表与独立检查器**（测试侧手段，故意写成 `*.spec.ts`：可被其他 spec import，
 * 又不进发布产物——与 engine 的 `scheduleFixtures.spec.ts` / `scheduleInvariants.spec.ts` 同一手法）。
 *
 * ## 两条纪律（都在 G4-S 里踩过）
 *
 * 1. **期望值写在数据里，内核无权改基准**（同 `schedule.manual.spec.ts` 的手法）。
 *    条形的左右边界写成 **ISO 日期**而不是像素魔数：`xLeft = dayOfOrdinal(es)`、
 *    `xRight = dayOfOrdinal(ef − 1) + 1` —— 这就是 ADR 0007 §3 的规则本身；
 *    `naiveRightIso` 是"误用 `dayOfOrdinal(ef)`"会得到的值，用来证明判据**有判别力**。
 * 2. **检查器不得复制几何公式**：端点"应当在哪"必须复用 `taskBounds`。
 *    G4-S 第一版正是在检查器里重写了条形右边界公式，于是里程碑端点被误判 8 px
 *    （CONTRIBUTING 反复强调的"两个真相源"陷阱）。
 */

import type { Calendar, ProjectDocument, Schedule } from '@ganttpilot/engine';
import { describe, expect, it } from 'vitest';

import { barXRange, milestoneCenterX, rowIndexOfOrder, taskBounds } from './domain.js';
import { EDGE_WRAP_PX, zoomPxPerDay } from './manifest.js';
import { routeEdge, routeSides, type RouteSide } from './route.js';
import { dayAtX, ordinalAtX, type ViewModel } from './viewModel.js';

/** 基准日历的 `baseDay`（与夹具的 `FIXTURE_PROJECT_START_ISO` 一致）。 */
export const MANUAL_BASE_ISO = '2026-10-05';

/** 一条声明式期望值的通用结果。 */
export interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

/** 期望值表的用例形状（声明式数据）。 */
export interface ManualCase {
  readonly name: string;
  readonly kind: 'bar' | 'milestone' | 'route';
  readonly zoom: 'day' | 'week' | 'month';
  readonly es?: number;
  readonly ef?: number;
  readonly relation?: 'FS' | 'SS' | 'FF' | 'SF';
  readonly from?: { readonly es: number; readonly ef: number };
  readonly to?: { readonly es: number; readonly ef: number };
  readonly expect: {
    readonly xLeftIso?: string;
    readonly xRightIso?: string;
    readonly naiveRightIso?: string;
    readonly centerIso?: string;
    readonly centerOffsetDays?: number;
    readonly exitSide?: RouteSide;
    readonly enterSide?: RouteSide;
    readonly arrowDir?: number;
    readonly wrapped?: boolean;
    readonly verticalXRule?: 'midpoint' | 'minMinusWrap';
  };
}

/**
 * 几何声明式期望值表（**内核无权改基准**）。
 *
 * 口径：基准日历的 `baseDay` = `2026-10-05`（周一），因此序号 0 = 2026-10-05、
 * 4 = 2026-10-09（周五）、5 = 2026-10-12（周一）、6 = 2026-10-13（周二）、
 * 8 = 2026-10-15（周四）、20 = 2026-11-02、21 = 2026-11-03、22 = 2026-11-04。
 *
 * 路由用例声明的是**枚举与方向**（P-8 第 1 条的内容）；px 数值由声明式 ISO 边界 + 冻结公式导出，
 * 因此不写成魔数。
 */
export const MANUAL_CASES: readonly ManualCase[] = [
  {
    name: '日档·单日任务',
    kind: 'bar',
    zoom: 'day',
    es: 0,
    ef: 1,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-06', naiveRightIso: '2026-10-06' },
  },
  {
    name: '日档·周一至周五（跨周末右边界）',
    kind: 'bar',
    zoom: 'day',
    es: 0,
    ef: 5,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-10', naiveRightIso: '2026-10-12' },
  },
  {
    name: '日档·周五+周一（ef−1 恰落在周一，两种写法一致）',
    kind: 'bar',
    zoom: 'day',
    es: 4,
    ef: 6,
    expect: { xLeftIso: '2026-10-09', xRightIso: '2026-10-13', naiveRightIso: '2026-10-13' },
  },
  {
    name: '日档·跨月',
    kind: 'bar',
    zoom: 'day',
    es: 20,
    ef: 22,
    expect: { xLeftIso: '2026-11-02', xRightIso: '2026-11-04', naiveRightIso: '2026-11-04' },
  },
  {
    name: '周档·同任务（ISO 边界不变，只有 pxPerDay 变）',
    kind: 'bar',
    zoom: 'week',
    es: 0,
    ef: 5,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-10', naiveRightIso: '2026-10-12' },
  },
  {
    name: '月档·同任务（ISO 边界不变）',
    kind: 'bar',
    zoom: 'month',
    es: 0,
    ef: 5,
    expect: { xLeftIso: '2026-10-05', xRightIso: '2026-10-10', naiveRightIso: '2026-10-12' },
  },
  {
    name: '里程碑·取所在工作日格的中点',
    kind: 'milestone',
    zoom: 'day',
    es: 8,
    ef: 8,
    expect: { centerIso: '2026-10-15', centerOffsetDays: 0.5 },
  },
  {
    name: 'FS：右出 → 左入（前置在后置左侧）',
    kind: 'route',
    zoom: 'day',
    relation: 'FS',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    expect: { exitSide: 'right', enterSide: 'left', arrowDir: 1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SS：左出 → 左入（目标在右侧，不回绕）',
    kind: 'route',
    zoom: 'day',
    relation: 'SS',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    expect: { exitSide: 'left', enterSide: 'left', arrowDir: 1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SS：左出 → 左入（目标在前置左侧 ⇒ 必须回绕）',
    kind: 'route',
    zoom: 'day',
    relation: 'SS',
    from: { es: 8, ef: 12 },
    to: { es: 0, ef: 5 },
    expect: { exitSide: 'left', enterSide: 'left', arrowDir: 1, wrapped: true, verticalXRule: 'minMinusWrap' },
  },
  {
    name: 'FF：右出 → 右入（前置在后置左侧）',
    kind: 'route',
    zoom: 'day',
    relation: 'FF',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    expect: { exitSide: 'right', enterSide: 'right', arrowDir: -1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SF：左出 → 右入（前置在后置左侧）',
    kind: 'route',
    zoom: 'day',
    relation: 'SF',
    from: { es: 0, ef: 5 },
    to: { es: 8, ef: 10 },
    expect: { exitSide: 'left', enterSide: 'right', arrowDir: -1, wrapped: false, verticalXRule: 'midpoint' },
  },
  {
    name: 'SF：左出 → 右入（目标在前置左侧 ⇒ 必须回绕）',
    kind: 'route',
    zoom: 'day',
    relation: 'SF',
    from: { es: 8, ef: 12 },
    to: { es: 0, ef: 5 },
    expect: { exitSide: 'left', enterSide: 'right', arrowDir: -1, wrapped: true, verticalXRule: 'minMinusWrap' },
  },
];

/**
 * 逐条比对声明式期望值表。
 *
 * 三个 `mutate*` 开关是 **NC3 的载体**（故意错的几何必须被检出）：
 * 右边界用 `dayOfOrdinal(ef)`、交换出/入边、箭头朝向取反。
 */
export function checkManualCases(args: {
  readonly calendar: Calendar;
  readonly stubPx?: number;
  readonly wrapPx?: number;
  readonly mutateRightBoundary?: boolean;
  readonly mutateRouteSides?: boolean;
  readonly mutateArrowDir?: boolean;
}): readonly CheckResult[] {
  const results: CheckResult[] = [];
  for (const manualCase of MANUAL_CASES) {
    const origin = args.calendar.dayOfOrdinal(0); // 序号 0 = baseDay = 2026-10-05
    const pxPerDay = zoomPxPerDay('day');

    if (manualCase.kind === 'bar') {
      const es = manualCase.es ?? 0;
      const ef = manualCase.ef ?? 0;
      const range = barXRange({ calendar: args.calendar, es, ef, axisOriginDay: origin, pxPerDay });
      const correctRightDay = args.calendar.dayOfOrdinal(ef - 1) + 1;
      const naiveRightDay = args.calendar.dayOfOrdinal(ef);
      const actualLeft = args.calendar.isoOfDay(range.leftDay);
      const actualRight = args.calendar.isoOfDay(args.mutateRightBoundary === true ? naiveRightDay : correctRightDay);
      const naiveRight = args.calendar.isoOfDay(naiveRightDay);
      const expected = manualCase.expect;
      const passLeft = actualLeft === expected.xLeftIso;
      const passRight = actualRight === expected.xRightIso;
      const passNaive = naiveRight === expected.naiveRightIso;
      results.push({
        name: `期望值表·${manualCase.name}`,
        pass: passLeft && passRight && passNaive,
        detail: `xLeft=${actualLeft}（期望 ${String(expected.xLeftIso)}）、xRight=${actualRight}（期望 ${String(expected.xRightIso)}）、naive=${naiveRight}（期望 ${String(expected.naiveRightIso)}）`,
      });
      continue;
    }

    if (manualCase.kind === 'milestone') {
      const es = manualCase.es ?? 0;
      const cx = milestoneCenterX({ calendar: args.calendar, es, axisOriginDay: origin, pxPerDay });
      const centerDay = cx / pxPerDay + origin;
      const expectedDay = args.calendar.dayOfOrdinal(es) + (manualCase.expect.centerOffsetDays ?? 0);
      const pass = Math.abs(centerDay - expectedDay) < 1e-9;
      results.push({
        name: `期望值表·${manualCase.name}`,
        pass,
        detail: `中心日序号=${String(centerDay)}，期望=${String(expectedDay)}（${args.calendar.isoOfDay(args.calendar.dayOfOrdinal(es))} + ${String(manualCase.expect.centerOffsetDays)} 天）`,
      });
      continue;
    }

    // 路由用例：断言的是**枚举与方向**（P-8 第 1 条的内容）。
    const fromCase = manualCase.from ?? { es: 0, ef: 1 };
    const toCase = manualCase.to ?? { es: 0, ef: 1 };
    const relation = manualCase.relation ?? 'FS';
    const relationSides = routeSides(relation);
    const fromRange = barXRange({
      calendar: args.calendar,
      es: fromCase.es,
      ef: fromCase.ef,
      axisOriginDay: origin,
      pxPerDay,
    });
    const toRange = barXRange({
      calendar: args.calendar,
      es: toCase.es,
      ef: toCase.ef,
      axisOriginDay: origin,
      pxPerDay,
    });
    const sides =
      args.mutateRouteSides === true
        ? { exit: relationSides.enter, enter: relationSides.exit }
        : { exit: relationSides.exit, enter: relationSides.enter };
    const route = routeEdge({
      exitSide: sides.exit,
      enterSide: sides.enter,
      exitX: sides.exit === 'right' ? fromRange.xRight : fromRange.xLeft,
      enterX: sides.enter === 'right' ? toRange.xRight : toRange.xLeft,
      yFrom: 0,
      yTo: 40,
      ...(args.stubPx === undefined ? {} : { stubPx: args.stubPx }),
      ...(args.wrapPx === undefined ? {} : { wrapPx: args.wrapPx }),
    });
    const expected = manualCase.expect;
    const arrowDir = args.mutateArrowDir === true ? -route.arrowDir : route.arrowDir;
    const passSides = sides.exit === expected.exitSide && sides.enter === expected.enterSide;
    const passWrap = route.wrapped === expected.wrapped;
    const passArrow = arrowDir === expected.arrowDir;
    const expectedVerticalX =
      expected.verticalXRule === 'midpoint'
        ? (route.exitStubX + route.enterStubX) / 2
        : Math.min(route.exitStubX, route.enterStubX) - (args.wrapPx ?? EDGE_WRAP_PX);
    const passVertical = Math.abs(route.verticalX - expectedVerticalX) < 1e-9;
    results.push({
      name: `期望值表·${manualCase.name}`,
      pass: passSides && passWrap && passArrow && passVertical,
      detail: `exit=${sides.exit}/${String(expected.exitSide)}、enter=${sides.enter}/${String(expected.enterSide)}、wrapped=${String(route.wrapped)}/${String(expected.wrapped)}、arrowDir=${String(arrowDir)}/${String(expected.arrowDir)}、verticalX=${String(route.verticalX)}`,
    });
  }
  return results;
}

/** 反算不变量：`dayAtX(xLeft) = dayOfOrdinal(es)`、`dayAtX(xRight) = dayOfOrdinal(ef−1)+1`、`ordinalAtX(xLeft) = es`。 */
export function checkRoundTrip(args: { readonly view: ViewModel; readonly calendar: Calendar }): readonly CheckResult[] {
  const { view, calendar } = args;
  const failures: string[] = [];
  let checked = 0;
  for (const row of view.rows) {
    if (row.kind === 'summary' || row.isMilestone) continue;
    checked += 1;
    const dayLeft = dayAtX(view, row.xLeft);
    const expectedLeft = calendar.dayOfOrdinal(row.es);
    if (Math.abs(dayLeft - expectedLeft) > 1e-9) {
      failures.push(`行 ${String(row.row)}（${row.id}）xLeft 反算=${String(dayLeft)}，期望=${String(expectedLeft)}`);
    }
    const expectedRight = calendar.dayOfOrdinal(row.ef - 1) + 1;
    const dayRight = dayAtX(view, row.xRight);
    if (Math.abs(dayRight - expectedRight) > 1e-9) {
      failures.push(
        `行 ${String(row.row)}（${row.id}）xRight 反算=${String(dayRight)}，期望=${String(expectedRight)}（ef−1 再 +1）`,
      );
    }
    const ordinal = ordinalAtX(view, row.xLeft, calendar);
    if (ordinal !== row.es) {
      failures.push(`行 ${String(row.row)}（${row.id}）ordinalAtX=${String(ordinal)}，期望 es=${String(row.es)}`);
    }
  }
  return [
    {
      name: '反算不变量：dayAtX(xLeft)=dayOfOrdinal(es)、dayAtX(xRight)=dayOfOrdinal(ef−1)+1、ordinalAtX(xLeft)=es',
      pass: failures.length === 0,
      detail: `检查 ${String(checked)} 个叶子行；违规 ${String(failures.length)} 条${failures.length > 0 ? `：${failures.slice(0, 3).join('；')}` : ''}`,
    },
  ];
}

/** 边端点必须贴合条边中点（**复用 `taskBounds`**），且汇总条覆盖子树。 */
export function checkEdgeEndpointsAndSummaryCoverage(args: {
  readonly view: ViewModel;
  readonly document: ProjectDocument;
  readonly schedule: Schedule;
  readonly calendar: Calendar;
}): readonly CheckResult[] {
  const { view, document, schedule, calendar } = args;
  const rowOfDocIndex = rowIndexOfOrder(view.order, document.tasks.length);

  const sideX = (docIndex: number, side: RouteSide): { x: number; y: number } | null => {
    const bounds = taskBounds({
      document,
      schedule,
      calendar,
      rowOfDocIndex,
      axisOriginDay: view.axisOriginDay,
      pxPerDay: view.pxPerDay,
      rowHeight: view.rowHeight,
      docIndex,
    });
    if (bounds === null) return null;
    return { x: side === 'right' ? bounds.xRight : bounds.xLeft, y: bounds.y };
  };

  const endpointFailures: string[] = [];
  for (const edge of view.edges) {
    const first = edge.points[0];
    const last = edge.points[edge.points.length - 1];
    const sides = routeSides(edge.type);
    const fromBound = sideX(edge.fromDoc, sides.exit);
    const toBound = sideX(edge.toDoc, sides.enter);
    if (first === undefined || last === undefined || fromBound === null || toBound === null) {
      endpointFailures.push(`${edge.linkId}：端点不可解析`);
      continue;
    }
    if (Math.abs(first[0] - fromBound.x) > 1e-9 || Math.abs(first[1] - fromBound.y) > 1e-9) {
      endpointFailures.push(
        `${edge.linkId}：起点 (${String(first[0])},${String(first[1])}) ≠ 出端 (${String(fromBound.x)},${String(fromBound.y)})`,
      );
    }
    if (Math.abs(last[0] - toBound.x) > 1e-9 || Math.abs(last[1] - toBound.y) > 1e-9) {
      endpointFailures.push(
        `${edge.linkId}：终点 (${String(last[0])},${String(last[1])}) ≠ 入端 (${String(toBound.x)},${String(toBound.y)})`,
      );
    }
  }

  const childrenOf = new Map<string, number[]>();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task === undefined || task.parentId === null) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket === undefined) childrenOf.set(task.parentId, [index]);
    else bucket.push(index);
  }
  const collectLeaves = (parentId: string): number[] => {
    const leaves: number[] = [];
    const stack = [...(childrenOf.get(parentId) ?? [])];
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined) continue;
      if ((schedule.es[index] ?? -1) === -1) {
        stack.push(...(childrenOf.get(document.tasks[index]?.id ?? '') ?? []));
      } else leaves.push(index);
    }
    return leaves;
  };

  const coverageFailures: string[] = [];
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task === undefined) continue;
    if ((schedule.es[index] ?? -1) !== -1) continue;
    const descendantLeaves = collectLeaves(task.id);
    if (descendantLeaves.length === 0) continue;
    const minEs = Math.min(...descendantLeaves.map((leaf) => schedule.es[leaf] ?? 0));
    const maxEf = Math.max(...descendantLeaves.map((leaf) => schedule.ef[leaf] ?? 0));
    const summaryEs = schedule.summaryEs[index] ?? -1;
    const summaryEf = schedule.summaryEf[index] ?? -1;
    if (summaryEs !== minEs || summaryEf !== maxEf) {
      coverageFailures.push(
        `${task.id}：summaryEs/Ef=${String(summaryEs)}/${String(summaryEf)}，子树实测=${String(minEs)}/${String(maxEf)}`,
      );
    }
  }

  return [
    {
      name: '边端点贴合条边中点（首点 = 出端、末点 = 入端，y = 条竖向中心）',
      pass: endpointFailures.length === 0,
      detail: `检查 ${String(view.edges.length)} 条边；违规 ${String(endpointFailures.length)} 条${endpointFailures.length > 0 ? `：${endpointFailures.slice(0, 3).join('；')}` : ''}`,
    },
    {
      name: '汇总条覆盖子树（summaryEs/summaryEf = 子树叶子的 min/max）',
      pass: coverageFailures.length === 0,
      detail: `违规 ${String(coverageFailures.length)} 条${coverageFailures.length > 0 ? `：${coverageFailures.slice(0, 3).join('；')}` : ''}`,
    },
  ];
}

/**
 * 裁剪健全性（S4-b 的**正面表述**）：凡是"与可见行窗口相交"的边，求交路径**一条都不丢**；
 * 折叠隐藏的行在两种路径下都不画其边（两者的 `hiddenEdges` 必须逐条相同）。
 */
export function checkClipSoundness(args: {
  readonly intersectView: ViewModel;
  readonly endpointView: ViewModel;
}): readonly CheckResult[] {
  const intersect = new Set(args.intersectView.edges.map((edge) => edge.linkId));
  const endpoints = new Set(args.endpointView.edges.map((edge) => edge.linkId));
  const lost = [...endpoints].filter((id) => !intersect.has(id));
  const hiddenInBoth = args.intersectView.hiddenEdges.filter((index) =>
    args.endpointView.hiddenEdges.includes(index),
  );
  return [
    {
      name: '裁剪健全性：求交路径必须**不丢**任何"与可见行窗口相交"的边',
      pass: lost.length === 0,
      detail: `求交渲染 ${String(intersect.size)} 条、端点可见性渲染 ${String(endpoints.size)} 条`,
    },
    {
      name: '折叠健全性：折叠隐藏的行在两种路径下都不画其边（`hiddenEdges` 逐条相同）',
      pass: hiddenInBoth.length === args.intersectView.hiddenEdges.length,
      detail: `隐藏边 ${String(args.intersectView.hiddenEdges.length)} 条，两条路径一致隐藏 ${String(hiddenInBoth.length)} 条`,
    },
  ];
}

/** 哨兵守卫：`-1` 绝不可喂给几何（必须抛 `RangeError`，不得静默出 `NaN`）。 */
export function checkSentinelGuard(args: { readonly calendar: Calendar }): readonly CheckResult[] {
  const throwsOn = (es: number, ef: number): boolean => {
    try {
      barXRange({ calendar: args.calendar, es, ef, axisOriginDay: 0, pxPerDay: 24 });
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  };
  const esGuard = throwsOn(-1, 5);
  const efGuard = throwsOn(0, -1);
  const invertedGuard = throwsOn(8, 5);
  const milestoneGuard = (() => {
    try {
      milestoneCenterX({ calendar: args.calendar, es: -1, axisOriginDay: 0, pxPerDay: 24 });
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  })();
  return [
    {
      name: '哨兵守卫：es=-1 / ef=-1 / es>ef 喂进条形几何，以及 es=-1 喂进里程碑几何，都必须抛 RangeError',
      pass: esGuard && efGuard && invertedGuard && milestoneGuard,
      detail: `es=-1：${String(esGuard)}、ef=-1：${String(efGuard)}、es>ef：${String(invertedGuard)}、milestone es=-1：${String(milestoneGuard)}`,
    },
  ];
}

/** P-8 第 1 条的可执行副本（供 spec 直接断言，避免在测试里再抄一份）。 */
export const EXPECTED_ROUTE_SIDES: Readonly<Record<string, { readonly exit: RouteSide; readonly enter: RouteSide }>> = {
  FS: { exit: 'right', enter: 'left' },
  SS: { exit: 'left', enter: 'left' },
  FF: { exit: 'right', enter: 'right' },
  SF: { exit: 'left', enter: 'right' },
};

// ---------------------------------------------------------------- 本文件自检
//
// Vitest 收集 `packages/*/src/**/*.spec.ts`，所以这份"测试侧手段"必须**自带用例**
// （否则 `passWithNoTests: false` 会让整次运行失败）。自检的内容是
// "期望值表本身是良构的"——判据有判别力（`naiveRightIso` 至少一处不同）与
// 用例编号唯一，避免后续有人加一条期望值却把它写成恒真式。

describe('声明式期望值表自检（测试侧手段）', () => {
  it('13 条用例、名称唯一', () => {
    expect(MANUAL_CASES).toHaveLength(13);
    const names = MANUAL_CASES.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每条用例都声明了期望值，且条形用例都带 naive 对照值', () => {
    for (const item of MANUAL_CASES) {
      if (item.kind === 'bar') {
        expect(item.expect.xLeftIso).toBeTypeOf('string');
        expect(item.expect.xRightIso).toBeTypeOf('string');
        expect(item.expect.naiveRightIso).toBeTypeOf('string');
      } else if (item.kind === 'milestone') {
        expect(item.expect.centerIso).toBeTypeOf('string');
        expect(item.expect.centerOffsetDays).toBe(0.5);
      } else {
        expect(item.expect.exitSide).toBeTypeOf('string');
        expect(item.expect.enterSide).toBeTypeOf('string');
        expect([1, -1]).toContain(item.expect.arrowDir);
      }
    }
  });

  it('至少一条用例的 `naiveRightIso` 与正确值不同（否则判据没有判别力）', () => {
    const differ = MANUAL_CASES.filter(
      (item) => item.kind === 'bar' && item.expect.xRightIso !== item.expect.naiveRightIso,
    );
    expect(differ.length).toBeGreaterThan(0);
  });

  it('4 类关系都被期望值表覆盖，且回绕与不回绕各有用例', () => {
    const routeCases = MANUAL_CASES.filter((item) => item.kind === 'route');
    expect(new Set(routeCases.map((item) => item.relation))).toStrictEqual(new Set(['FS', 'SS', 'FF', 'SF']));
    expect(routeCases.some((item) => item.expect.wrapped === true)).toBe(true);
    expect(routeCases.some((item) => item.expect.wrapped === false)).toBe(true);
  });

  it('期望值表与 P-8 第 1 条一致（出入边枚举），三条负向对照都至少能被一条检出错', () => {
    expect(EXPECTED_ROUTE_SIDES).toStrictEqual({
      FS: { exit: 'right', enter: 'left' },
      SS: { exit: 'left', enter: 'left' },
      FF: { exit: 'right', enter: 'right' },
      SF: { exit: 'left', enter: 'right' },
    });
    for (const item of MANUAL_CASES) {
      if (item.kind !== 'route' || item.relation === undefined) continue;
      const sides = EXPECTED_ROUTE_SIDES[item.relation];
      expect(item.expect.exitSide).toBe(sides?.exit);
      expect(item.expect.enterSide).toBe(sides?.enter);
    }
  });
});

