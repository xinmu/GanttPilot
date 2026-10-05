/**
 * 内置**演示计划**：页面默认文档、重置、G7 的导出演示与 golden 比对都用它（裁决 P-34）。
 *
 * ## 为什么与 `fixtures.ts` 分开（本轮最常见的误解）
 *
 * 这是**两个不同口径**，不能合成一个：
 *
 * - **演示口径**（本文件）：手写的 15 行通用软件项目计划。它要的是**单页可读**——
 *   3 个阶段汇总 + 10 个任务 + 2 个里程碑、14 条依赖（四类关系齐备、含正负 lag），
 *   序号跨度 ≤ 40 个工作日（同一视口口径下日档 `contentWidth` 1,372 px、周档恰好一屏、
 *   15 行 × 24 px = 360 px 高，可整幅落在一页 16:9 里）。
 *   现状的 `dense` 夹具是 1,000 任务 / 1,500 依赖、日档 `contentWidth` **10,612 px**（约 8 屏宽），
 *   作为导出演示与 golden 比对的主体不可读。
 * - **规模口径**（`fixtures.ts`）：确定性生成器产出的 1,000 任务三种形态 + 2,200 边同尺对照 +
 *   规模梯度。它服务**记录制测量与各包 spec**（"1,000 任务 / 1,500 依赖"这句话的载体）。
 *
 * 因此本文件**不**改 `DATASETS`、**不**走 `generateDocument`：命名与结构必须是人写的，
 * 而生成器只会造 `任务 N` / `阶段 N`。两条口径的分工与依据见 [P-34](../../../docs/00-baseline/裁决R33.md)。
 *
 * ## 纪律
 *
 * - **零 `Math.random`**：行数据是常量表，两次 `createDemoPlanDocument()` 必须逐字节一致
 *   （这正是"模板 A 可重复生成"的 golden 前置）；
 * - **落库前 `reindexDocument`**：`outlineNumber` 是派生值（ADR 0002 ③），不手写；
 * - **依赖只向前**：边的 `to` 一律晚于 `from` 的文档序 ⇒ 结构上不可能成环；
 * - **不出汇总端点边**：汇总端点边在传播里被忽略（`SCHEDULE.md` §四.4），留着只会给演示
 *   添一条 `LINK_SUMMARY_ENDPOINT` warning；
 * - **不发明日期**：只有链路起点 `t1` 显式给 `startDate`（走锚点情形①），其余任务靠传播定位。
 *   "有工期、无日期"（DM-05）会产出 `TASK_DURATION_WITHOUT_DATES` warning——**这是合法表达**，
 *   不许靠硬塞 `startDate` 消掉它（那会破坏"拖动改期"的演示语义）；warning 的条数由
 *   `demoPlan.spec.ts` 显式钉住。
 */

import {
  reindexDocument,
  type DocumentLink,
  type DocumentTask,
  type LinkType,
  type ProjectDocument,
} from '@ganttpilot/engine';

import { FIXTURE_PROJECT_START_ISO } from './fixtures.js';

/** 演示计划的一行（行数据的**唯一真相源**）。 */
interface DemoPlanRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  /** `null` = 汇总行（不参与传播）。 */
  readonly durationDays: number | null;
  readonly progress: number | null;
  readonly milestone: boolean;
  /** 显式锚定日期：只有链路起点需要（其余任务由传播定位）。 */
  readonly startDate: string | null;
}

/** 汇总行（`durationDays: null`；`SCHEMA.md` §2.1）。 */
function summaryRow(id: string, name: string): DemoPlanRow {
  return { id, parentId: null, name, durationDays: null, progress: null, milestone: false, startDate: null };
}

/** 任务行 / 里程碑行（里程碑 ⇒ `durationDays: 0`、`milestone: true`）。 */
function taskRow(
  id: string,
  parentId: string,
  name: string,
  durationDays: number,
  progress: number,
  startDate: string | null = null,
): DemoPlanRow {
  return { id, parentId, name, durationDays, progress, milestone: durationDays === 0, startDate };
}

/**
 * 15 行演示计划。
 *
 * 结构与数值（**已实测**：`compute` ok、0 error、0 排程诊断、3 个汇总进度 0.817 / 0.239 / 0.000）：
 * 阶段一 立项与方案（进度 82% 的前半程）→ 阶段二 开发与联调（24%）→ 阶段三 验收与上线（0%）——
 * 这个"前半程已完成、后半程未开始"的形态是**刻意**的：模板 A 的自动摘要
 * （完成率 / 里程碑数 / 里程碑清单）要能同时展示"已完成、进行中、未开始"三档。
 */
const DEMO_PLAN_ROWS: readonly DemoPlanRow[] = [
  summaryRow('s1', '阶段一 · 立项与方案'),
  taskRow('t1', 's1', '需求调研', 5, 1, FIXTURE_PROJECT_START_ISO),
  taskRow('t2', 's1', '竞品分析', 3, 0.8),
  taskRow('t3', 's1', '方案编写', 4, 0.6),
  taskRow('m1', 's1', '里程碑：方案评审通过', 0, 1),
  summaryRow('s2', '阶段二 · 开发与联调'),
  taskRow('t4', 's2', '接口设计', 3, 0.5),
  taskRow('t5', 's2', '前端开发', 8, 0.25),
  taskRow('t6', 's2', '后端开发', 8, 0.25),
  taskRow('t7', 's2', '前后端联调', 4, 0),
  taskRow('m2', 's2', '里程碑：联调完成', 0, 0),
  summaryRow('s3', '阶段三 · 验收与上线'),
  taskRow('t8', 's3', '用户验收测试', 4, 0),
  taskRow('t9', 's3', '上线准备', 2, 0),
  taskRow('t10', 's3', '正式上线', 1, 0),
];

/**
 * 14 条依赖：**四类关系齐备**（FS / SS / FF / SF 都有，且含负 lag），
 * 每条都短（不跨屏），全部沿文档序向前。
 *
 * 刻意保留的四处"教学位"：
 * - `l2`（`SS +1`）与 `l3`（`FS −1`）：四类关系与负 lag 的可见样本；
 * - `l6`/`l7`：两条并行开发都用 `SS +2` 起（"并行工作流"的常见写法）；
 * - `l8`（`FF 0`）：前后端联调的"同时结束"约束；
 * - `l14`（`SF 0`，`t8 → t10`）：四类里最冷门的 SF——"上线**完成**不得早于验收测试**开始**"
 *   （防止"验收没开始就先上线"的顺序错误）。它对当前排程**不紧**（`t10` 由 `l13` 的 FS 链定位），
 *   因此既补齐了第四类箭头几何，又不改动上面那套已实测的 es/ef 形态。
 */
const DEMO_PLAN_LINKS: readonly DocumentLink[] = [
  link('l1', 't1', 't2', 'FS', 0),
  link('l2', 't1', 't3', 'SS', 1),
  link('l3', 't2', 't3', 'FS', -1),
  link('l4', 't3', 'm1', 'FS', 0),
  link('l5', 't3', 't4', 'FS', 1),
  link('l6', 't4', 't5', 'SS', 2),
  link('l7', 't4', 't6', 'SS', 2),
  link('l8', 't5', 't7', 'FF', 0),
  link('l9', 't6', 't7', 'FS', 0),
  link('l10', 't7', 'm2', 'FS', 0),
  link('l11', 't7', 't8', 'FS', 2),
  link('l12', 't8', 't9', 'FS', 0),
  link('l13', 't9', 't10', 'FS', 0),
  link('l14', 't8', 't10', 'SF', 0),
];

/** 依赖边构造（只为了上表可读：字段顺序与 `DocumentLink` 一致）。 */
function link(id: string, from: string, to: string, type: LinkType, lagDays: number): DocumentLink {
  return { id, from, to, type, lagDays };
}

/** 行 → 文档任务（`outlineNumber` 留空，由 `reindexDocument` 填写）。 */
function toTask(row: DemoPlanRow): DocumentTask {
  return {
    id: row.id,
    parentId: row.parentId,
    outlineNumber: '',
    name: row.name,
    startDate: row.startDate,
    endDate: null,
    durationDays: row.durationDays,
    progress: row.progress,
    milestone: row.milestone,
    collapsed: false,
    notes: null,
    manual: false,
    constraints: [],
  };
}

/**
 * 造一份"落库前规范化过"的演示计划文档（`outlineNumber` 是派生值，ADR 0002 ③）。
 *
 * 返回**新建对象**（不是共享单例）：调用方（`useProject` 的会话、spec、测量）可能各自持有并编辑它，
 * 共享一份会被命令层改到别处；确定性由"常量行数据 + 无随机"保证，而不是由对象同一性保证。
 */
export function createDemoPlanDocument(): ProjectDocument {
  return reindexDocument({
    version: 3,
    project: {
      name: '演示计划 · Pilot 项目',
      description: null,
      baseCalendarId: 'project',
      startDate: FIXTURE_PROJECT_START_ISO,
      finishDate: null,
    },
    calendars: [{ id: 'project', exceptions: { nonWorking: [], working: [] } }],
    tasks: DEMO_PLAN_ROWS.map(toTask),
    links: DEMO_PLAN_LINKS,
    baselines: [],
  });
}
