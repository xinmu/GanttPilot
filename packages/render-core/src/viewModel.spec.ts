/**
 * 行模型与视图模型（ADR 0007 §3 / §4 / §7）：
 * 折叠过滤、汇总判别式、里程碑分支、进度语义、轴与刻度（含**水平窗口裁剪**）、
 * 以及退化状态（空项目 / 全汇总 / 被折叠的子树）下不得出现 `NaN` 坐标。
 */

import { describe, expect, it } from 'vitest';
import {
  compute,
  createScheduleCalendar,
  createEmptyDocument,
  reindexDocument,
  type DocumentTask,
  type ProjectDocument,
  type ProjectMeta,
} from '@ganttpilot/engine';

import {
  axisOriginDayFor,
  buildAxis,
  rowWindow,
} from './clip.js';
import { rowIndexOfOrder, taskBounds, visibleRowOrder } from './domain.js';
import { buildFixture, DATASETS, FIXTURE_PROJECT_START_ISO, REFERENCE_DATASET } from './fixtures.js';
import { datasetOf } from '../test/fixtures.testkit.js';
import {
  AXIS_LEFT_GUTTER_DAYS,
  CONTENT_RIGHT_PAD_PX,
  EDGE_STUB_PX,
  EDGE_WRAP_PX,
  ROW_BUFFER,
  ROW_HEIGHT,
  ZOOM_ORDER,
  ZOOM_PX_PER_DAY,
} from './manifest.js';
import {
  buildView,
  contentWidthFor,
  DEFAULT_VIEWPORT,
  isRowRendered,
  visibleEdges,
  visibleRows,
} from './viewModel.js';

const PROJECT: ProjectMeta = {
  name: '行模型用例',
  description: null,
  baseCalendarId: 'project',
  startDate: FIXTURE_PROJECT_START_ISO,
  finishDate: null,
};

function task(overrides: Partial<DocumentTask> & { id: string }): DocumentTask {
  return {
    parentId: null,
    outlineNumber: '',
    name: overrides.id,
    startDate: null,
    endDate: null,
    durationDays: 1,
    progress: null,
    milestone: false,
    collapsed: false,
    notes: null,
    manual: false,
    constraints: [],
    ...overrides,
  };
}

function documentWith(tasks: readonly DocumentTask[]): ProjectDocument {
  return reindexDocument({
    version: 3,
    project: PROJECT,
    calendars: [{ id: 'project', exceptions: { nonWorking: [], working: [] } }],
    tasks: [...tasks],
    links: [],
    baselines: [],
  });
}

describe('行模型（ADR 0007 §4）', () => {
  it('可见行 = 树序经折叠过滤；折叠汇总的整棵子树不进可见行', () => {
    const doc = documentWith([
      task({ id: 's1', name: '阶段', durationDays: null, collapsed: true }),
      task({ id: 'a', parentId: 's1' }),
      task({ id: 'b', parentId: 'a' }),
      task({ id: 'c' }),
    ]);
    const order = visibleRowOrder(doc);
    expect(order).toStrictEqual([0, 3]);
    const rowOf = rowIndexOfOrder(order, doc.tasks.length);
    expect([...rowOf]).toStrictEqual([0, -1, -1, 1]);
  });

  it('未折叠时层级仍然是"父先于子"的文档序', () => {
    const doc = documentWith([
      task({ id: 's1', durationDays: null }),
      task({ id: 'a', parentId: 's1' }),
      task({ id: 'b', parentId: 's1' }),
      task({ id: 'c' }),
    ]);
    expect(visibleRowOrder(doc)).toStrictEqual([0, 1, 2, 3]);
  });

  it('空文档不抛错、行窗口为空', () => {
    const doc = createEmptyDocument('空项目');
    expect(visibleRowOrder(doc)).toStrictEqual([]);
    const win = rowWindow({ rowCount: 0, scrollTop: 0, height: 640, rowHeight: 24, rowBuffer: ROW_BUFFER });
    expect(win.visibleLast).toBe(-1);
    expect(win.renderLast).toBe(-1);
  });
});

describe('视图模型（ADR 0007 §2/§3/§7）', () => {
  const fixture = buildFixture(datasetOf('dense'));

  it('`es[i] === -1` 是唯一的汇总判别式：汇总行取 summaryEs/summaryEf 与 summaryProgress', () => {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    const summaryRows = view.rows.filter((row) => row.kind === 'summary');
    expect(summaryRows.length).toBeGreaterThan(0);
    for (const row of summaryRows) {
      expect(fixture.schedule.es[row.docIndex]).toBe(-1);
      expect(row.es).toBe(fixture.schedule.summaryEs[row.docIndex]);
      expect(row.ef).toBe(fixture.schedule.summaryEf[row.docIndex]);
      expect(row.styleKey).toBe('bar-summary');
      // 汇总条不加端帽（元素预算口径）——行模型只出"一个条"，没有额外图元。
      expect(row.milestone).toBeNull();
    }
  });

  it('里程碑走菱形分支（中心 = 所在工作日格中点 +0.5 天；不调用 ef−1 公式）', () => {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    const milestones = view.rows.filter((row) => row.isMilestone);
    expect(milestones.length).toBeGreaterThan(0);
    for (const row of milestones) {
      expect(row.styleKey).toBe('milestone');
      expect(row.milestone).not.toBeNull();
      expect(row.hasProgress).toBe(false);
      const centerDay = fixture.calendar.dayOfOrdinal(row.es) + 0.5;
      expect(row.milestone?.cx).toBeCloseTo((centerDay - view.axisOriginDay) * view.pxPerDay, 9);
    }
  });

  it('条形右边界 = dayOfOrdinal(ef − 1) + 1（跨周末不多出空隙）', () => {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    for (const row of view.rows) {
      if (row.isMilestone || row.kind === 'summary') continue;
      const expected = (fixture.calendar.dayOfOrdinal(row.ef - 1) + 1 - view.axisOriginDay) * view.pxPerDay;
      expect(row.xRight).toBeCloseTo(expected, 9);
    }
  });

  it('进度未知（null）与汇总进度 NaN 都不画填充（不是 0%）', () => {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    for (const row of view.rows) {
      const docProgress = fixture.document.tasks[row.docIndex]?.progress ?? null;
      if (row.kind === 'summary') {
        const value = fixture.schedule.summaryProgress[row.docIndex];
        expect(row.hasProgress).toBe(Number.isFinite(value));
      } else if (docProgress === null) {
        expect(row.hasProgress).toBe(false);
      }
      if (!row.hasProgress) expect(row.progressWidth).toBe(0);
    }
  });

  it('裁剪先于几何：只对渲染窗口（可见行 + 缓冲）内的行算几何', () => {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    const visibleCount = Math.max(1, Math.ceil(view.height / view.rowHeight));
    const windowSize = visibleCount + 2 * ROW_BUFFER;
    // 滚动在顶部 ⇒ 上侧缓冲被 `Math.max(0, …)` 截断，因此渲染窗口是 32 而不是 37。
    const expectedWindow = Math.min(view.rowCount, view.visibleLast + 1 + ROW_BUFFER);
    expect(view.rows.length).toBe(expectedWindow);
    expect(view.rows.length).toBeLessThanOrEqual(Math.min(view.rowCount, windowSize));
    for (const row of view.rows) {
      expect(row.row).toBeGreaterThanOrEqual(view.renderFirst);
      expect(row.row).toBeLessThanOrEqual(view.renderLast);
    }
    // 左表要按**整列**渲染，所以 order 是完整可见行序列，不受窗口裁剪。
    expect(view.order.length).toBe(view.rowCount);
    expect(view.rows.length).toBeLessThan(view.rowCount);
  });

  it('visibleRows / visibleEdges 出文档序索引与 links 下标；isRowRendered 与窗口一致', () => {
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    expect(visibleRows(view)).toStrictEqual(view.rows.map((row) => row.docIndex));
    expect(visibleEdges(view)).toStrictEqual(view.edges.map((edge) => edge.linkIndex));
    for (const docIndex of visibleRows(view)) expect(isRowRendered(view, docIndex)).toBe(true);
    const outside = view.order[view.renderLast + 1];
    if (outside !== undefined) expect(isRowRendered(view, outside)).toBe(false);
  });

  it('折叠改变可见行集合后，被折叠子树的行与边都不渲染（无悬空线）', () => {
    const collapsed = buildFixture({ ...datasetOf('dense'), key: 'dense-collapsed-1-3', collapsedSummaries: [1, 3] });
    const view = buildView({
      document: collapsed.document,
      schedule: collapsed.schedule,
      calendar: collapsed.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    const hiddenIds = new Set(collapsed.stats.hiddenIds);
    expect(hiddenIds.size).toBeGreaterThan(0);
    for (const row of view.rows) expect(hiddenIds.has(row.id)).toBe(false);
    for (const edge of view.edges) {
      const link = collapsed.document.links[edge.linkIndex];
      expect(hiddenIds.has(link?.from ?? '')).toBe(false);
      expect(hiddenIds.has(link?.to ?? '')).toBe(false);
    }
  });

  it('全部汇总（无叶子）：不产生条形、不产生 NaN 坐标', () => {
    // 有子任务的父节点才是汇总（`compute` 的汇总判别式来自层级，不是 `durationDays === null`）；
    // 两个叶子无日期无入边 ⇒ 走情形②（回落项目起点），父节点是纯汇总。
    const doc = documentWith([
      task({ id: 'p', durationDays: null }),
      task({ id: 'c1', parentId: 'p', durationDays: 1 }),
      task({ id: 'c2', parentId: 'p', durationDays: 2 }),
    ]);
    const calendar = createScheduleCalendar(doc);
    const result = compute(doc, calendar);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 前提校验：p 确实是汇总（es === -1）、c1/c2 是叶子。
    expect(result.schedule.es[0]).toBe(-1);
    expect(result.schedule.es[1]).toBeGreaterThanOrEqual(0);

    const view = buildView({
      document: doc,
      schedule: result.schedule,
      calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    expect(view.rows.map((row) => row.kind)).toStrictEqual(['summary', 'leaf', 'leaf']);
    expect(view.rows.map((row) => row.id)).toStrictEqual(['p', 'c1', 'c2']);
    expect(Number.isFinite(view.axisOriginDay)).toBe(true);
    for (const row of view.rows) {
      expect(Number.isFinite(row.xLeft)).toBe(true);
      expect(Number.isFinite(row.xRight)).toBe(true);
    }
    for (const element of view.axis) expect(Number.isFinite(element.x)).toBe(true);
  });
});

describe('轴与刻度（ADR 0007 §3 + §11.1 ③ 水平窗口裁剪）', () => {
  const fixture = buildFixture(datasetOf('dense'));

  it('轴线起点：按档位向前取整到该档位起点，再向左留 gutter', () => {
    const ord = fixture.schedule.projectStart;
    const startDay = fixture.calendar.dayOfOrdinal(ord);
    const originFor = (zoom: 'day' | 'week' | 'month'): number =>
      axisOriginDayFor({
        calendar: fixture.calendar,
        projectStartOrdinal: ord,
        zoom,
        gutterDays: AXIS_LEFT_GUTTER_DAYS,
      });
    // 2026-10-05 是周一 ⇒ 周档向前取整到自身；月档取 1 日。
    expect(originFor('day') + AXIS_LEFT_GUTTER_DAYS).toBe(startDay);
    expect(originFor('week') + AXIS_LEFT_GUTTER_DAYS).toBe(startDay);
    expect(fixture.calendar.isoOfDay(originFor('month') + AXIS_LEFT_GUTTER_DAYS)).toBe('2026-10-01');
  });

  it('轴元素落在视口 x 范围内（第三维裁剪）：超出视口的元素不发射', () => {
    const origin = axisOriginDayFor({
      calendar: fixture.calendar,
      projectStartOrdinal: fixture.schedule.projectStart,
      zoom: 'day',
      gutterDays: AXIS_LEFT_GUTTER_DAYS,
    });
    const width = 1280;
    for (const zoom of ['day', 'week', 'month'] as const) {
      for (const scrollLeft of [0, 500, 5000, 50000]) {
        const axis = buildAxis({
          calendar: fixture.calendar,
          axisOriginDay: origin,
          pxPerDay: ZOOM_PX_PER_DAY[zoom],
          scrollLeft,
          width,
          zoom,
        });
        for (const element of axis) {
          // 色带与**上级分段带**（P-46）的判据不是"起点在视口内"，而是"**与视口相交**"：
          // 它们的起点可以在视口左侧（段被左边界截断），宽度也可以越出右缘——这符合
          // §11.1 ③ 的口径（"合并成极大连续段"必然跨边界），而"不发射视口外的元素"由这条相交判据承担。
          if (element.kind === 'band' || element.kind === 'major-band') {
            expect(element.x).toBeLessThanOrEqual(width);
            expect(element.x + element.width).toBeGreaterThanOrEqual(0);
          } else if (element.kind === 'hover-band') {
            // 覆盖层：窗口坐标、整幅宽（P-46 §2.2），与水平裁剪无关。
            expect(element.x).toBe(0);
            expect(element.width).toBe(width);
          } else {
            expect(element.x).toBeGreaterThanOrEqual(-1);
            expect(element.x).toBeLessThanOrEqual(width + 1);
          }
        }
      }
    }
  });

  it('非工作日色带合并为极大连续段（一个 rect 代表一段），且周末确实占位', () => {
    const origin = fixture.calendar.dayOfOrdinal(fixture.schedule.projectStart) - AXIS_LEFT_GUTTER_DAYS;
    const axis = buildAxis({
      calendar: fixture.calendar,
      axisOriginDay: origin,
      pxPerDay: ZOOM_PX_PER_DAY.day,
      scrollLeft: 0,
      width: 1280,
      zoom: 'day',
    });
    const bands = axis.filter((element) => element.kind === 'band');
    // 视口 54 天里含 8 个周末段（每段 2 天）；若"一天一个 rect"会得到 16 个。
    expect(bands).toHaveLength(8);
    // 合并的判据：至少有一段的宽度 ≥ 2 天（被视口左边界截断的首段只有 1 天，是正常现象）。
    const widths = bands.filter((band) => band.kind === 'band').map((band) => band.width);
    expect(widths.filter((width) => width >= 2 * ZOOM_PX_PER_DAY.day).length).toBeGreaterThanOrEqual(7);
  });

  it('档位只改 pxPerDay 与刻度步进，不改任何序号 ↔ 日期的对应', () => {
    const ordinal = 8;
    expect(fixture.calendar.isoOfDay(fixture.calendar.dayOfOrdinal(ordinal))).toBe('2026-10-15');
    for (const zoom of ['day', 'week', 'month'] as const) {
      const view = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport: DEFAULT_VIEWPORT,
        zoom,
      });
      expect(view.pxPerDay).toBe(ZOOM_PX_PER_DAY[zoom]);
      // 序号 → 日期永远只经 Calendar 翻译，与档位无关。
      expect(fixture.calendar.isoOfOrdinal(ordinal)).toBe('2026-10-15');
    }
  });

  it('行高固定：折叠/展开只改变行数，不改变行高假设', () => {
    const expanded = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    // 折叠**全部**汇总：可见行只剩汇总本身（叶子全部隐藏）。
    const collapsedFixture = buildFixture({
      ...datasetOf('dense'),
      key: 'dense-collapsed-all',
      collapsedSummaries: Array.from({ length: datasetOf('dense').summaries }, (_, index) => index + 1),
    });
    const collapsed = buildView({
      document: collapsedFixture.document,
      schedule: collapsedFixture.schedule,
      calendar: collapsedFixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    expect(expanded.rowHeight).toBe(ROW_HEIGHT);
    expect(collapsed.rowHeight).toBe(ROW_HEIGHT);
    expect(collapsed.rowCount).toBe(datasetOf('dense').summaries);
    expect(collapsed.rowCount).toBeLessThan(expanded.rowCount);
    // 行高是虚拟化的前提：折叠只改变行数；渲染窗口仍是"可见行 + 缓冲"。
    expect(collapsed.rows.length).toBe(Math.min(collapsed.rowCount, collapsed.visibleLast + 1 + ROW_BUFFER));
    expect(collapsed.rows.every((row) => row.kind === 'summary')).toBe(true);
  });
});

describe('内容横向范围（ADR 0007 §15，裁决 P-24）', () => {
  /**
   * 旧式（应用层）公式：**按窗格宽**推导内容宽。
   *
   * 把它留在 spec 里当**负向对照**：若有人改回这种做法，第一条判据必须变红
   * ——否则"能滚到项目末端"就是一句没有载体的空话。
   */
  const legacyContentWidth = (viewportWidth: number, pxPerDay: number): number => {
    const days = Math.max(60, viewportWidth / pxPerDay + 32);
    return Math.ceil(days * pxPerDay) + 32;
  };

  it('内容宽覆盖**全部任务的最右缘**（+ 引出段 + 回绕走廊），与窗格宽无关', () => {
    const failures: string[] = [];
    for (const spec of [...DATASETS, REFERENCE_DATASET]) {
      const fixture = buildFixture(spec);
      for (const zoom of ZOOM_ORDER) {
        const view = buildView({
          document: fixture.document,
          schedule: fixture.schedule,
          calendar: fixture.calendar,
          viewport: DEFAULT_VIEWPORT,
          zoom,
        });
        let rightMost = Number.NEGATIVE_INFINITY;
        for (let docIndex = 0; docIndex < fixture.document.tasks.length; docIndex += 1) {
          const bounds = taskBounds({
            document: fixture.document,
            schedule: fixture.schedule,
            calendar: fixture.calendar,
            rowOfDocIndex: view.rowOfDocIndex,
            axisOriginDay: view.axisOriginDay,
            pxPerDay: view.pxPerDay,
            rowHeight: view.rowHeight,
            docIndex,
          });
          if (bounds !== null) rightMost = Math.max(rightMost, bounds.xRight);
        }
        const needed = rightMost + EDGE_STUB_PX + EDGE_WRAP_PX;
        if (!(view.contentWidth >= needed)) {
          failures.push(`${spec.key}/${zoom}: contentWidth=${String(view.contentWidth)} < ${String(needed)}`);
        }
        if (view.contentWidth < DEFAULT_VIEWPORT.width) {
          failures.push(`${spec.key}/${zoom}: contentWidth 不得小于窗格宽`);
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });

  it('负向对照：旧式"按窗格宽推导"在 1,000 任务夹具上**不满足**该性质（判据有判别力）', () => {
    const fixture = buildFixture(datasetOf('wide'));
    const view = buildView({
      document: fixture.document,
      schedule: fixture.schedule,
      calendar: fixture.calendar,
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    const legacy = legacyContentWidth(DEFAULT_VIEWPORT.width, ZOOM_PX_PER_DAY.day);
    let rightMost = Number.NEGATIVE_INFINITY;
    for (let docIndex = 0; docIndex < fixture.document.tasks.length; docIndex += 1) {
      const bounds = taskBounds({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        rowOfDocIndex: view.rowOfDocIndex,
        axisOriginDay: view.axisOriginDay,
        pxPerDay: view.pxPerDay,
        rowHeight: view.rowHeight,
        docIndex,
      });
      if (bounds !== null) rightMost = Math.max(rightMost, bounds.xRight);
    }
    // 旧式公式只给到视口那几十天；真实内容的右缘远在它之外。
    expect(legacy).toBeLessThan(rightMost);
    expect(view.contentWidth).toBeGreaterThan(rightMost);
  });

  it('随项目末端单调增长；空文档回落到窗格宽（不可滚、也不给负范围）', () => {
    const base = {
      calendar: { dayOfOrdinal: (ordinal: number): number => 20731 + ordinal },
      axisOriginDay: 20723,
      pxPerDay: 24,
      viewportWidth: 400,
    };
    const near = contentWidthFor({ ...base, projectFinish: 11 });
    const far = contentWidthFor({ ...base, projectFinish: 101 });
    expect(far).toBeGreaterThan(near);
    expect(contentWidthFor({ ...base, projectFinish: 0 })).toBe(400);
    expect(contentWidthFor({ ...base, projectFinish: -1 })).toBe(400);

    const empty = createEmptyDocument('空项目');
    const result = compute(empty, createScheduleCalendar(empty));
    if (!result.ok) throw new Error('空项目应当可排程');
    const view = buildView({
      document: empty,
      schedule: result.schedule,
      calendar: createScheduleCalendar(empty),
      viewport: DEFAULT_VIEWPORT,
      zoom: 'day',
    });
    expect(view.contentWidth).toBe(DEFAULT_VIEWPORT.width);
    // 留白常数必须真的被用上（否则"最末任务之后还有余地"只是巧合）。
    expect(CONTENT_RIGHT_PAD_PX).toBeGreaterThan(0);
  });
});