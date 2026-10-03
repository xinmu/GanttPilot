/**
 * 不变量与**声明式期望值表**（ADR 0007 §9 的第 ① ③ 层）。
 *
 * 手法沿用 `schedule.manual.spec.ts`：期望值写在 `manifest.mjs` 里，**内核无权改基准**；
 * 这里的代码只负责"算出实际值并与期望逐条比对"。
 *
 * @typedef {import('../../../packages/engine/dist/index.js').Calendar} Calendar
 * @typedef {import('../../../packages/engine/dist/index.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../../packages/engine/dist/index.js').Schedule} Schedule
 * @typedef {{ name: string, pass: boolean, detail: string }} CheckResult
 */

import { EDGE_WRAP_PX, MANUAL_CASES, ROUTE_SIDES, zoomPxPerDay } from './manifest.mjs';
import { rowIndexOfOrder } from './clip.mjs';
import { barXRange, dayAtX, milestoneCenterX, ordinalAtX, routeEdge, taskBounds } from './view-model.mjs';

/** 基准日历的 `baseDay`（与 `generateDocument` 的 `PROJECT_START_ISO` 一致）。 */
export const MANUAL_BASE_ISO = '2026-10-05';

/**
 * 声明式几何期望值表逐条比对。
 *
 * @param {object} args
 * @param {Calendar} args.calendar
 * @param {number} [args.stubPx]
 * @param {number} [args.wrapPx]
 * @param {boolean} [args.mutateRightBoundary] 负向对照：故意用 `dayOfOrdinal(ef)`（错的右边界规则）
 * @param {boolean} [args.mutateRouteSides] 负向对照：故意交换出/入边
 * @param {boolean} [args.mutateArrowDir] 负向对照：故意把箭头朝向取反
 * @returns {readonly CheckResult[]}
 */
export function checkManualCases({
  calendar,
  stubPx,
  wrapPx,
  mutateRightBoundary = false,
  mutateRouteSides = false,
  mutateArrowDir = false,
}) {
  /** @type {CheckResult[]} */
  const results = [];
  for (const manualCase of MANUAL_CASES) {
    const origin = calendar.dayOfOrdinal(0); // 基准日历：序号 0 = baseDay = 2026-10-05
    // 声明式期望值是"ISO 边界"，与 pxPerDay 无关；这里用**日档选定值**，只为把期望值换成像素做比对。
    const pxPerDay = zoomPxPerDay('day');
    if (manualCase.kind === 'bar') {
      const es = manualCase.es ?? 0;
      const ef = manualCase.ef ?? 0;
      const range = barXRange({ calendar, es, ef, axisOriginDay: origin, pxPerDay });
      // 正确规则与"误用 dayOfOrdinal(ef)"都必须算出来：前者是判据，后者证明判据有判别力。
      const correctRightDay = calendar.dayOfOrdinal(ef - 1) + 1;
      const naiveRightDay = calendar.dayOfOrdinal(ef);
      const actualLeft = calendar.isoOfDay(range.leftDay);
      const actualRight = calendar.isoOfDay(mutateRightBoundary ? naiveRightDay : correctRightDay);
      const naiveRight = calendar.isoOfDay(naiveRightDay);
      const expected = manualCase.expect;
      const passLeft = actualLeft === expected.xLeftIso;
      const passRight = actualRight === expected.xRightIso;
      const passNaive = naiveRight === expected.naiveRightIso;
      results.push({
        name: `期望值表·${manualCase.name}`,
        pass: passLeft && passRight && passNaive,
        detail: `xLeft=${actualLeft}（期望 ${expected.xLeftIso}）、xRight=${actualRight}（期望 ${expected.xRightIso}）、naive=${naiveRight}（期望 ${expected.naiveRightIso}）`,
      });
      continue;
    }
    if (manualCase.kind === 'milestone') {
      const es = manualCase.es ?? 0;
      const cx = milestoneCenterX({ calendar, es, axisOriginDay: origin, pxPerDay });
      const centerDay = cx / pxPerDay + origin;
      const expectedDay = calendar.dayOfOrdinal(es) + (manualCase.expect.centerOffsetDays ?? 0);
      const pass = Math.abs(centerDay - expectedDay) < 1e-9;
      results.push({
        name: `期望值表·${manualCase.name}`,
        pass,
        detail: `中心日序号=${String(centerDay)}，期望=${String(expectedDay)}（${String(calendar.isoOfDay(calendar.dayOfOrdinal(es)))} + ${String(manualCase.expect.centerOffsetDays)} 天）`,
      });
      continue;
    }
    // 路由用例：断言的是**枚举与方向**（P-8 第 1 条的内容），px 数值由声明式 ISO 边界导出。
    const fromCase = manualCase.from ?? { es: 0, ef: 1 };
    const toCase = manualCase.to ?? { es: 0, ef: 1 };
    const relation = manualCase.relation ?? 'FS';
    const relationSides = ROUTE_SIDES[relation] ?? ROUTE_SIDES.FS;
    const fromRange = barXRange({
      calendar,
      es: fromCase.es,
      ef: fromCase.ef,
      axisOriginDay: origin,
      pxPerDay,
    });
    const toRange = barXRange({
      calendar,
      es: toCase.es,
      ef: toCase.ef,
      axisOriginDay: origin,
      pxPerDay,
    });
    const sides = mutateRouteSides
      ? { exit: relationSides.enter, enter: relationSides.exit }
      : relationSides;
    const route = routeEdge({
      exitSide: sides.exit,
      enterSide: sides.enter,
      exitX: sides.exit === 'right' ? fromRange.xRight : fromRange.xLeft,
      enterX: sides.enter === 'right' ? toRange.xRight : toRange.xLeft,
      yFrom: 0,
      yTo: 40,
      stubPx,
      wrapPx,
    });
    const expected = manualCase.expect;
    const arrowDir = mutateArrowDir ? -route.arrowDir : route.arrowDir;
    const passSides = sides.exit === expected.exitSide && sides.enter === expected.enterSide;
    const passWrap = route.wrapped === expected.wrapped;
    const passArrow = arrowDir === expected.arrowDir;
    const expectMidpoint = expected.verticalXRule === 'midpoint';
    const expectedVerticalX = expectMidpoint
      ? (route.exitStubX + route.enterStubX) / 2
      : Math.min(route.exitStubX, route.enterStubX) - (wrapPx ?? EDGE_WRAP_PX);
    const passVertical = Math.abs(route.verticalX - expectedVerticalX) < 1e-9;
    results.push({
      name: `期望值表·${manualCase.name}`,
      pass: passSides && passWrap && passArrow && passVertical,
      detail: `exit=${sides.exit}/${expected.exitSide}、enter=${sides.enter}/${expected.enterSide}、wrapped=${String(route.wrapped)}/${String(expected.wrapped)}、arrowDir=${String(arrowDir)}/${String(expected.arrowDir)}、verticalX=${String(route.verticalX)}`,
    });
  }
  return results;
}

/**
 * 反算往返与右边界规则（ADR 0007 §9 第 ③ 层）。
 *
 * @param {object} args
 * @param {ReturnType<import('./view-model.mjs').buildView>} args.view
 * @param {Calendar} args.calendar
 * @returns {readonly CheckResult[]}
 */
export function checkRoundTrip({ view, calendar }) {
  /** @type {string[]} */
  const failures = [];
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

/**
 * 边端点必须贴合条边中点，且**汇总条覆盖子树**。
 *
 * @param {object} args
 * @param {ReturnType<import('./view-model.mjs').buildView>} args.view
 * @param {Schedule} args.schedule
 * @param {ProjectDocument} args.document
 * @param {Calendar} args.calendar
 * @returns {readonly CheckResult[]}
 */
export function checkEdgeEndpointsAndSummaryCoverage({ view, schedule, document, calendar }) {
  const rowOfDocIndex = rowIndexOfOrder(view.order, document.tasks.length);
  /** @type {string[]} */
  const endpointFailures = [];
  for (const edge of view.edges) {
    const first = edge.points[0];
    const last = edge.points[edge.points.length - 1];
    const sides = ROUTE_SIDES[edge.type] ?? ROUTE_SIDES.FS;
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

  /**
   * 端点"应当在哪"**必须复用几何本身**（`taskBounds`），不得在这里再写一份。
   *
   * 本探针第一版就是在检查器里复制了"条形右边界"公式，于是里程碑端点被误判——
   * 这正是 CONTRIBUTING 反复强调的"两个真相源"陷阱（已修）。
   *
   * @param {number} docIndex
   * @param {'left'|'right'} side
   */
  function sideX(docIndex, side) {
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
  }

  /** @type {string[]} */
  const coverageFailures = [];
  const childrenOf = new Map();
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index];
    if (task === undefined || task.parentId === null) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket === undefined) childrenOf.set(task.parentId, [index]);
    else bucket.push(index);
  }
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
  /** @param {string} parentId */
  function collectLeaves(parentId) {
    /** @type {number[]} */
    const leaves = [];
    const stack = [...(childrenOf.get(parentId) ?? [])];
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined) continue;
      if ((schedule.es[index] ?? -1) === -1) stack.push(...(childrenOf.get(document.tasks[index]?.id ?? '') ?? []));
      else leaves.push(index);
    }
    return leaves;
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
 * 裁剪健全性：**凡是与可见行窗口相交的边都必须被画**（否则就是"错误隐藏跨屏长边"）。
 *
 * 这是 S4-b 的正面表述：判据不是"路径 A 丢得少"，而是"路径 A 一条都不该丢"。
 *
 * @param {object} args
 * @param {ReturnType<import('./view-model.mjs').buildView>} args.intersectView
 * @param {ReturnType<import('./view-model.mjs').buildView>} args.endpointView
 * @returns {readonly CheckResult[]}
 */
export function checkClipSoundness({ intersectView, endpointView }) {
  const intersect = new Set(intersectView.edges.map((edge) => edge.linkId));
  const endpoints = new Set(endpointView.edges.map((edge) => edge.linkId));
  const lost = [...endpoints].filter((id) => !intersect.has(id));
  const hiddenInBoth = intersectView.hiddenEdges.filter((index) => endpointView.hiddenEdges.includes(index));
  return [
    {
      name: '裁剪健全性：求交路径必须**不丢**任何"与可见行窗口相交"的边',
      pass: lost.length === 0,
      detail: `求交渲染 ${String(intersect.size)} 条、端点可见性渲染 ${String(endpoints.size)} 条`,
    },
    {
      name: '折叠健全性：折叠隐藏的行在两种路径下都不画其边',
      pass: hiddenInBoth.length === intersectView.hiddenEdges.length,
      detail: `隐藏边 ${String(intersectView.hiddenEdges.length)} 条，两条路径一致隐藏 ${String(hiddenInBoth.length)} 条`,
    },
  ];
}

/** 哨兵守卫：`-1` 绝不可喂给几何（负向对照必须抛错）。 */
export function checkSentinelGuard({ calendar }) {
  let threw = false;
  try {
    barXRange({ calendar, es: -1, ef: 5, axisOriginDay: 0, pxPerDay: 28 });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  let threwSummary = false;
  try {
    barXRange({ calendar, es: 0, ef: -1, axisOriginDay: 0, pxPerDay: 28 });
  } catch (error) {
    threwSummary = error instanceof RangeError;
  }
  return [
    {
      name: '哨兵守卫：es=-1 / ef=-1 喂进几何必须抛 RangeError（不得静默出 NaN）',
      pass: threw && threwSummary,
      detail: `es=-1 抛错=${String(threw)}、ef=-1 抛错=${String(threwSummary)}`,
    },
  ];
}
