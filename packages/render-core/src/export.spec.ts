/**
 * 导出链路判据（**进 `pnpm gate`**，ADR 0010）。
 *
 * 覆盖四块：导出投影（全量渲染 / 不被视口宽污染）、单页适配（等比 + 贴边 + 居中）、
 * 可读性提示（阈值与建议动作，ADR §11 的回填数值在此被钉住）、SVG 序列化（几何同源 + 无交互图元 +
 * 两次调用逐字符一致），以及自动摘要（**与引擎同一完成率公式的互证**）。
 *
 * 手法沿用既有 spec：
 * - **几何同源**靠逐值断言（SVG 的坐标 == `ViewModel` 的坐标），不靠"看起来对"；
 * - **负向对照**至少两条（裁剪 vs 全量的元素数差异；非等比缩放必须不成立）；
 * - **golden 前置**：同一输入两次序列化逐字符相等（"模板 A 可重复生成"的雏形）。
 */

import { describe, expect, it } from 'vitest';
import { compute, reindexDocument, type DocumentTask, type Schedule } from '@ganttpilot/engine';

import { createDemoPlanDocument } from './demoPlan.js';
import {
  buildExportView,
  exportAdvisoryFor,
  exportReadabilityOf,
  EXPORT_LABEL_WIDTH_PX,
  fitScaleFor,
  EXPORT_PAGE_16_9,
  pxToPt,
} from './exportView.js';
import { exportLegendItems, exportSummaryLines, exportSummaryOf, formatCompletionRatio } from './exportSummary.js';
import {
  EXPORT_LABEL_INDENT_PX,
  EXPORT_LABEL_MAX_DEPTH,
  exportLabelStyleOf,
  exportLabelTextOf,
} from './exportLabels.js';
import { PRIMARY_DATASET_KEY, generateDocument } from './fixtures.js';
import { datasetOf } from '../test/fixtures.testkit.js';
import { createScheduleCalendar, buildView } from './index.js';
import { AXIS_BAND_FILL, AXIS_GRIDLINE_STROKE, HEADER_HEIGHT_PX, LABEL_CHAR_PX, ROW_HEIGHT } from './manifest.js';
import { svgInnerSizeOf, svgString } from './svgExport.js';

function fixtureOfDemo(): {
  readonly document: ReturnType<typeof createDemoPlanDocument>;
  readonly calendar: ReturnType<typeof createScheduleCalendar>;
  // **P3/C7-c 的类型诚实化**：原写法是
  // `NonNullable<ReturnType<typeof compute> extends { ok: true; schedule: infer S } ? S : never>`。
  // 实测（`tmp/probe-cond.ts`，同一 `--strict` 开关）那个条件类型**不归约**：`compute` 的返回
  // 类型是联合 `ScheduleResult`，在其中做 `infer S` 时 `S` 被推成 `never`，于是 `NonNullable`
  // 也救不回来 ⇒ 本函数的 `schedule` 字段类型已经是 `never`，`return { …, schedule: result.schedule }`
  // 报 TS2322、`schedule.milestoneCount` 报 TS2339。旧 program 不含 spec，所以这两处从未被看见。
  // 引擎自己导出了 `Schedule`，直接用它是"honest 的那一个名字"（类型注解，不改运行时）。
  readonly schedule: Schedule;
} {
  const document = createDemoPlanDocument();
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) throw new Error('演示计划不可排程');
  return { document, calendar, schedule: result.schedule };
}

function denseFixture() {
  const document = reindexDocument(
    generateDocument(datasetOf(PRIMARY_DATASET_KEY)).document,
  );
  const calendar = createScheduleCalendar(document);
  const result = compute(document, calendar);
  if (!result.ok) throw new Error('dense 夹具不可排程');
  return { document, calendar, schedule: result.schedule };
}

/**
 * 按 id 取演示计划里的任务（找不到即抛）。
 *
 * **P3/C7-c**：本文件此前把 `document.tasks.find(...)`（`DocumentTask | undefined`）直接喂给
 * `exportLabelStyleOf` / `exportLabelTextOf`（收 `DocumentTask`），或展开进一个要写回
 * `ProjectDocument` 的对象字面量里。两种写法在 `noUncheckedIndexedAccess` +
 * `exactOptionalPropertyTypes` 下都不成立：前者是 `TS2345`，后者更隐蔽——**联合展开会把
 * 必填属性降级成可选**（实测 `{...A} | {...B}` 展出的 `name` 是 `name?: string`），
 * 于是 `tasks: [...]` 不再是 `readonly DocumentTask[]`（`TS2322`）。
 * 这里把"演示计划里确实有这些 id"变成一条会失败的断言，而不是靠 `!` 或 `as` 压住。
 */
function demoTaskOf(id: string): DocumentTask {
  const found = fixtureOfDemo().document.tasks.find((task) => task.id === id);
  if (found === undefined) throw new Error(`演示计划里没有任务 ${String(id)}`);
  return found;
}

describe('导出投影（ADR 0010 §2）', () => {
  it('全量渲染：行数与边数与文档一致，且没有不可路由的边', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    expect(projection.rowCount).toBe(15);
    expect(projection.view.rows).toHaveLength(15);
    expect(projection.view.edges).toHaveLength(14);
    expect(projection.view.unroutableEdges).toBe(0);
    expect(projection.view.clipMode).toBe('none');
  });

  it('**不受视口宽污染**：contentWidth 只由文档右缘推出（屏幕那句 `max(视口宽, 右缘)` 不参与）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    // 屏幕口径：视口给到 5000 px，contentWidth 会被抬到 5000（滚动容器的需要）。
    const screen = buildView({
      document,
      schedule,
      calendar,
      zoom: 'day',
      viewport: { scrollTop: 0, scrollLeft: 0, width: 5000, height: 400, rowHeight: ROW_HEIGHT, rowBuffer: 0 },
    });
    expect(screen.contentWidth).toBe(5000);
    // 导出口径：文档右缘，稳定不受视口影响。
    expect(projection.contentWidth).toBeLessThan(2000);
    expect(projection.innerWidth).toBe(EXPORT_LABEL_WIDTH_PX + projection.contentWidth);
    expect(projection.innerHeight).toBe(HEADER_HEIGHT_PX + projection.view.rowCount * ROW_HEIGHT);
  });

  it('负向对照：窗口裁剪下的渲染行数**必须少于**全量（否则"全量渲染"这句话没有判别力）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const full = buildExportView({ document, schedule, calendar, zoom: 'day' });
    const clipped = buildView({
      document,
      schedule,
      calendar,
      zoom: 'day',
      viewport: { scrollTop: 0, scrollLeft: 0, width: 900, height: 200, rowHeight: ROW_HEIGHT, rowBuffer: 0 },
    });
    expect(clipped.rows.length).toBeLessThan(full.view.rows.length);
    expect(full.view.rows.length).toBe(full.rowCount);
  });

  it('1,000 任务夹具也能全量导出（行数 = 可见行数，不随视口裁剪）', () => {
    const { document, calendar, schedule } = denseFixture();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    expect(projection.view.rows).toHaveLength(projection.rowCount);
    expect(projection.rowCount).toBeLessThanOrEqual(document.tasks.length);
    expect(projection.rowCount).toBeGreaterThan(900);
  });
});

describe('单页适配（ADR 0010 §3）', () => {
  it('等比：两轴同一个 scale，且至少一轴贴边', () => {
    const transform = fitScaleFor({ innerWidth: 1592, innerHeight: 384, pageWidthPx: 960, pageHeightPx: 540 });
    const usedW = 1592 * transform.scale;
    const usedH = 384 * transform.scale;
    expect(usedW).toBeLessThanOrEqual(transform.availableWidth + 1e-9);
    expect(usedH).toBeLessThanOrEqual(transform.availableHeight + 1e-9);
    const tight = Math.abs(usedW - transform.availableWidth) < 1e-6 || Math.abs(usedH - transform.availableHeight) < 1e-6;
    expect(tight).toBe(true);
    // 居中：两个方向的偏移都不小于页边距。
    expect(transform.offsetX).toBeGreaterThanOrEqual(16 - 1e-9);
    expect(transform.offsetY).toBeGreaterThanOrEqual(16 - 1e-9);
  });

  it('负向对照：非等比缩放（两轴各自贴边）必须与本函数不同', () => {
    const inner = { innerWidth: 1592, innerHeight: 384 };
    const equal = fitScaleFor({ ...inner, pageWidthPx: 960, pageHeightPx: 540 });
    const nonEqualX = equal.availableWidth / inner.innerWidth;
    const nonEqualY = equal.availableHeight / inner.innerHeight;
    expect(nonEqualX).not.toBeCloseTo(nonEqualY, 6); // 前提自证：这个输入确实会拉开两轴
    expect(equal.scale).toBeCloseTo(Math.min(nonEqualX, nonEqualY), 12);
  });

  it('退化输入不抛错（空文档也要能导出一张空页）', () => {
    const transform = fitScaleFor({ innerWidth: 0, innerHeight: 0, pageWidthPx: 960, pageHeightPx: 540 });
    expect(transform.scale).toBe(1);
    expect(transform.offsetX).toBe(16);
  });
});

describe('可读性提示（ADR 0010 §11 的回填阈值）', () => {
  it('演示计划：日档不可读而周/月档可读 ⇒ 建议换档（数值与 S7-d 一致）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const day = exportAdvisoryFor({ document, schedule, calendar, zoom: 'day' });
    expect(day.advice).toBe('switch-zoom');
    expect(day.readableZooms).toStrictEqual(['week', 'month']);
    expect(day.current.verdict).toBe('unreadable');
    expect(day.current.labelFontPt).toBeLessThan(6);
    expect(pxToPt(EXPORT_PAGE_16_9.widthPx)).toBe(720);
  });

  it('1,000 任务：三档都不可读 ⇒ 建议折叠（不是换档）', () => {
    const { document, calendar, schedule } = denseFixture();
    const advisory = exportAdvisoryFor({ document, schedule, calendar, zoom: 'day' });
    expect(advisory.advice).toBe('collapse');
    expect(advisory.readableZooms).toStrictEqual([]);
    expect(advisory.current.labelFontPt).toBeLessThan(6);
  });

  it('阈值判读本身可判定（同一 scale 的三档判读）', () => {
    const small = exportReadabilityOf(
      fitScaleFor({ innerWidth: 1, innerHeight: 1, pageWidthPx: 960, pageHeightPx: 540 }),
    );
    expect(small.verdict).toBe('readable'); // scale 很大 ⇒ 字号很大
  });
});

describe('SVG 序列化（ADR 0010 §4）', () => {
  it('几何同源：逐行的条 x/宽 与 `ViewModel` 逐值相等（不是"看起来对"）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    const svg = svgString({ view: projection.view, document });
    for (const row of projection.view.rows) {
      if (row.isMilestone) continue;
      const x = Math.round(EXPORT_LABEL_WIDTH_PX + row.xLeft);
      const width = Math.max(1, Math.round(row.xRight - row.xLeft));
      expect(svg).toContain(`<rect class="bar" x="${String(x)}"`);
      expect(svg).toContain(`width="${String(width)}" height="${String(Math.round(row.barHeight))}"`);
    }
  });

  it('一个交互图元都不导出（手柄 / 连接点 / 热区 / 覆盖层）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    const svg = svgString({ view: projection.view, document });
    for (const forbidden of ['handle', 'connect-point', 'transparent', 'drag-outline', 'drag-marker', 'conflict', 'highlight', 'preview-']) {
      expect(svg).not.toContain(forbidden);
    }
  });

  it('行与边覆盖齐全：`data-task-id` / `data-link-id` 与模型一一对应', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    const svg = svgString({ view: projection.view, document });
    for (const row of projection.view.rows) expect(svg).toContain(`data-task-id="${row.id}"`);
    for (const edge of projection.view.edges) expect(svg).toContain(`data-link-id="${edge.linkId}"`);
    expect(svg.match(/data-task-id=/g)).toHaveLength(projection.view.rows.length);
    expect(svg.match(/data-link-id=/g)).toHaveLength(projection.view.edges.length);
  });

  it('语义化：含 `<title>`/`<desc>` 与分组，且坐标全为整数', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    const svg = svgString({ view: projection.view, document, options: { title: '演示计划' } });
    expect(svg).toContain('<title>演示计划</title>');
    expect(svg).toContain('<desc>');
    expect(svg).toContain('<g class="rows">');
    expect(svg).toContain('<g class="edges">');
    expect(svg).toContain('<g class="axis-labels">');
    // 坐标不带小数点（整数化；否则 golden 会被浮点噪声污染）
    expect(/x="-?\d+\.\d/.test(svg)).toBe(false);
    expect(/d="M-?\d+(\.\d+)? /.test(svg)).toBe(true);
  });

  it('**两次调用逐字符相等**（golden 前置）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'day' });
    expect(svgString({ view: projection.view, document })).toBe(svgString({ view: projection.view, document }));
  });

  it('图例与摘要按开关附加，并让适配公式知道侧栏（两处同源）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'week' });
    const summary = exportSummaryOf({ document, schedule, calendar });
    const plain = svgInnerSizeOf({ view: projection.view });
    const withSidebar = svgInnerSizeOf({ view: projection.view, options: { includeLegend: true, includeSummary: true, summary } });
    expect(withSidebar.innerWidth).toBeGreaterThan(plain.innerWidth);
    expect(withSidebar.sidebarWidth).toBeGreaterThan(0);

    const svg = svgString({
      view: projection.view,
      document,
      options: { includeLegend: true, includeSummary: true, summary },
    });
    expect(svg).toContain('图例');
    expect(svg).toContain('摘要');
    expect(svg).toContain(`width="${String(withSidebar.innerWidth)}"`);
    for (const item of exportLegendItems()) expect(svg).toContain(`data-style-key="${item.styleKey}"`);
  });
});

describe('导出标签样式（人工复验第 3 条：父节点加粗、子节点缩进）', () => {
  it('汇总加粗、子节点按 WBS 深度缩进、上限 3 级', () => {
    const byId = (id: string) => demoTaskOf(id);
    expect(exportLabelStyleOf(undefined)).toStrictEqual({ indentPx: 0, bold: false });
    // 阶段汇总：加粗、不缩进
    expect(exportLabelStyleOf(byId('s1'))).toStrictEqual({ indentPx: 0, bold: true });
    // 一级子任务与里程碑：缩进一级、不加粗
    expect(exportLabelStyleOf(byId('t1'))).toStrictEqual({ indentPx: EXPORT_LABEL_INDENT_PX, bold: false });
    expect(exportLabelStyleOf(byId('m1'))).toStrictEqual({ indentPx: EXPORT_LABEL_INDENT_PX, bold: false });
    // 深层：按段数 − 1，封顶
    expect(exportLabelStyleOf({ ...byId('t1'), outlineNumber: '1.2.3' }).indentPx).toBe(EXPORT_LABEL_INDENT_PX * 2);
    expect(exportLabelStyleOf({ ...byId('t1'), outlineNumber: '1.2.3.4.5' }).indentPx).toBe(
      EXPORT_LABEL_INDENT_PX * EXPORT_LABEL_MAX_DEPTH,
    );
  });

  it('标签文本 = `编号 名称`，超宽截断加省略号；缩进不计入文本（SVG 与 PPTX 因此逐字相同）', () => {
    const short = exportLabelTextOf({
      task: demoTaskOf('t1'),
      fallback: 't1',
      availablePx: EXPORT_LABEL_WIDTH_PX,
      charPx: LABEL_CHAR_PX,
    });
    expect(short).toBe('1.1 需求调研');
    const long = exportLabelTextOf({
      task: { ...demoTaskOf('t1'), name: '一个非常非常非常长的任务名称用于验证截断行为' },
      fallback: 't1',
      availablePx: 120,
      charPx: LABEL_CHAR_PX,
    });
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan('一个非常非常非常长的任务名称用于验证截断行为'.length);
  });

  it('SVG 里：汇总行的文字加粗、子行文字按缩进右移（与 PPTX 同源）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'week' });
    const svg = svgString({ view: projection.view, document });
    expect(svg).toContain('font-weight="bold"');
    // 汇总 s1 在 x=8，子行 t1 在 x=8+12
    expect(svg).toMatch(/data-task-id="s1"[\s\S]{0,300}?<text x="8"[^>]*font-weight="bold"/);
    expect(svg).toMatch(/data-task-id="t1"[\s\S]{0,300}?<text x="20"/);
    for (const row of projection.view.rows) {
      const task = document.tasks[row.docIndex];
      const text = exportLabelTextOf({ task, fallback: row.id, availablePx: EXPORT_LABEL_WIDTH_PX, charPx: LABEL_CHAR_PX });
      expect(svg).toContain(`>${text}</text>`);
    }
  });

  it('SVG 的背景与刻度**逐条同源**（灰度带 / 网格线 / 刻度文本的计数与 `view.axis` 一致）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'week' });
    const svg = svgString({ view: projection.view, document });
    const bands = projection.view.axis.filter((element) => element.kind === 'band').length;
    const grids = projection.view.axis.filter((element) => element.kind === 'gridline').length;
    const labels = projection.view.axis.filter((element) => element.kind === 'label').length;
    expect(bands).toBeGreaterThan(0);
    expect(svg.match(new RegExp(`fill="${AXIS_BAND_FILL}"`, 'g'))).toHaveLength(bands);
    expect(svg.match(new RegExp(`stroke="${AXIS_GRIDLINE_STROKE}"`, 'g'))).toHaveLength(grids);
    expect(svg.match(/<g class="axis-labels">/g)).toHaveLength(1);
    expect(labels).toBeGreaterThan(0);
    for (const element of projection.view.axis) {
      if (element.kind !== 'label') continue;
      expect(svg).toContain(`>${element.text}</text>`);
    }
  });

  it('图例里的依赖线画的是**真箭头**（FS/FF 实心、SS/SF 空心）', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const projection = buildExportView({ document, schedule, calendar, zoom: 'week' });
    const summary = exportSummaryOf({ document, schedule, calendar });
    const svg = svgString({
      view: projection.view,
      document,
      options: { includeLegend: true, includeSummary: true, summary },
    });
    const legendOf = (key: string): string =>
      new RegExp(`data-style-key="${key}"[\\s\\S]*?</g>`).exec(svg)?.[0] ?? '';
    expect(legendOf('edge-FS')).toContain('<polygon');
    expect(legendOf('edge-SS')).toContain('fill="#ffffff"');
    expect(legendOf('edge-FS')).not.toContain('fill="#ffffff"');
  });
});

describe('导出摘要文本行（SVG 与 PPTX 同源，人工复验第 4 条）', () => {
  it('两行统计 + 里程碑清单；超过上限时截断并注明总数', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const summary = exportSummaryOf({ document, schedule, calendar });
    const lines = exportSummaryLines(summary);
    expect(lines.headline).toStrictEqual(['任务 15 · 依赖 14', '里程碑 2 个 · 完成率 36%']);
    expect(lines.milestones).toStrictEqual([
      '1.4 里程碑：方案评审通过 · 2026-10-20',
      '2.5 里程碑：联调完成 · 2026-11-10',
    ]);
    const truncated = exportSummaryLines(summary, 1);
    expect(truncated.milestones).toStrictEqual(['1.4 里程碑：方案评审通过 · 2026-10-20', '…共 2 个']);
  });
});

describe('自动摘要（ADR 0010 §7）', () => {
  it('完成率与引擎**同一公式**：与"整篇叶子当作一棵树"的 `summaryProgress` 互证', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const summary = exportSummaryOf({ document, schedule, calendar });

    // 把演示计划的**叶子**整体挂到一个根汇总下，让引擎按同一公式算一遍总完成率。
    const leaves = document.tasks.filter((task) => task.durationDays !== null);
    const rolled = reindexDocument({
      ...document,
      tasks: [
        {
          ...demoTaskOf('s1'),
          id: 'root',
          parentId: null,
          name: '全部',
          durationDays: null,
          progress: null,
          milestone: false,
          collapsed: false,
          startDate: null,
        },
        ...leaves.map((task) => ({ ...task, parentId: 'root' })),
      ],
      links: [],
    });
    const rolledCalendar = createScheduleCalendar(rolled);
    const rolledResult = compute(rolled, rolledCalendar);
    expect(rolledResult.ok).toBe(true);
    if (!rolledResult.ok) return;
    const engineRatio = rolledResult.schedule.summaryProgress[0] ?? Number.NaN;
    expect(summary.completionRatio).not.toBeNull();
    expect(summary.completionRatio ?? -1).toBeCloseTo(engineRatio, 10);
    // 项目级完成率 = 全部叶子按工期加权（15.3 / 42 = 36%）；**不是**首个阶段的 82%。
    expect(formatCompletionRatio(summary.completionRatio)).toBe('36%');
  });

  it('里程碑数与引擎一致、清单按日期升序且带 ISO 日期', () => {
    const { document, calendar, schedule } = fixtureOfDemo();
    const summary = exportSummaryOf({ document, schedule, calendar });
    expect(summary.taskCount).toBe(15);
    expect(summary.linkCount).toBe(14);
    expect(summary.milestoneCount).toBe(schedule.milestoneCount);
    expect(summary.milestoneCount).toBe(2);
    expect(summary.milestones.map((item) => item.id)).toStrictEqual(['m1', 'm2']);
    expect(summary.milestones[0]?.dateIso).toBe('2026-10-20');
    expect(summary.milestones.every((item) => item.dateIso !== '')).toBe(true);
  });

  it('无工期权重时完成率为 `null`（显示「—」，不是 NaN/0）', () => {
    const { document, calendar } = fixtureOfDemo();
    const onlyMilestone = reindexDocument({
      ...document,
      tasks: document.tasks.filter((task) => task.milestone),
      links: [],
    });
    const result = compute(onlyMilestone, createScheduleCalendar(onlyMilestone));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = exportSummaryOf({ document: onlyMilestone, schedule: result.schedule, calendar });
    expect(summary.completionRatio).toBeNull();
    expect(formatCompletionRatio(summary.completionRatio)).toBe('—');
    void calendar;
  });
});
