# 渲染几何与裁剪规范（G4）

> 本文件是 `@ganttpilot/render-core` 的**权威规范**（与 [`engine/SCHEDULE.md`](../engine/SCHEDULE.md)、
> [`xlsx-protocol/PROTOCOL.md`](../xlsx-protocol/PROTOCOL.md) 同构），供 `apps/web`、
> **G5**（拖拽与命中反算）与 **G7**（导出投影）共同引用。
>
> 契约出处：[ADR 0007 渲染几何与裁剪契约](../../docs/02-adr/0007-渲染几何与裁剪契约.md)
> （**冻结面**：§2 包边界、§3 时间轴与 x 坐标、§4 行模型、§5 路由几何、§6 裁剪四条、
> §9 验证矩阵、§11 数值回填 + §11.1 三条口径澄清）；
> 数值来源：G4-S 准入定标实验（该目录已随 G4 落地删除，见[裁决 P-18](../../docs/00-baseline/裁决记录.md)；
> 四条门禁的结论已转为本包的 spec，浏览器计时口径已转为
> [`scripts/measure-render.mjs`](../../scripts/measure-render.mjs)）；
> 能力块出口条件见[首版能力顺序 §三 G4](../../docs/01-roadmap/首版能力顺序.md)。

## 一、四条铁律

1. **几何只有一份，且在门禁内。** 几何与裁剪是本包的**纯函数**（零 DOM、零框架，
   可在 `environment: 'node'` 下完整断言）。`apps/web` 与 G7 的导出投影**都只消费 `ViewModel`**——
   把几何写进 `apps/web` 会让它既进不了门禁、又被 G7 复制出第二份（两个真相源）。
2. **`ViewModel` 只出数字与枚举**：矩形、折线点列、文本锚点、样式键。
   **不出 SVG 字符串、不出 DOM**——"把数字写成属性"是渲染层的事。
3. **`-1` 是哨兵，绝不可喂给几何。** `es[i] === -1` ⟺ 第 i 行是汇总任务，
   这是 `Schedule` 形状里**唯一**的汇总判别式（[`SCHEDULE.md` §三](../engine/SCHEDULE.md)）。
   `barXRange` / `milestoneCenterX` 对非法序号**抛 `RangeError`**，不静默出 `NaN`。
4. **裁剪先于几何计算。** 先按窗口筛行与边，**再**算 path 与坐标；不得先算全量再过滤。

## 二、包边界与公共 API

| 模块 | 职责 |
|---|---|
| `manifest.ts` | **常量与判据的唯一声明处**（ADR §11 七项回填值 + `evaluateScaleCriteria()` 复推） |
| `route.ts` | 出/入边策略的可执行副本、正交折点 `routeEdge`、4 类箭头几何与可区分性度量 |
| `domain.ts` | 行序（树序经折叠过滤）、`barXRange`、`milestoneCenterX`、`taskBounds` |
| `clip.ts` | 行窗口、边窗口（求交 / 端点可见性 / 关裁剪）、轴元素与**水平窗口**、轴线起点 |
| `viewModel.ts` | `buildView`（主入口）、`dayAtX` / `ordinalAtX`（反算）、`visibleRows` / `visibleEdges` |
| `count.ts` | 元素计数（两路互证）与预算判定；G5 的 **`c₄ = perRenderedRow·rows + overlay`**（ADR 0008 §16.4：每渲染行 6 + 每帧固定 12；`countOverlays` 只承担"每帧固定"那一半，不随文档总规模增长） |
| `columns.ts` | **列身份的唯一真相源**（`COLUMN_SPECS` / `ColumnKey` / `SHEET_NAME` / `HEADER_ROW` / `TABLE_COLUMNS` 等；ADR 0008 §1–§3，`xlsx-protocol` 转型再导出） |
| `viewText.ts` | 单元格文本 `cellText`、日期文本工具、派生完成日 `derivedEndIso`、值→命令映射 `editToCommand` / `collapseToCommand`（**凡"只有日历能算"的量都显式收 `Calendar`**，P-19）；**行内编辑的基线文本与陈旧判定** `rawCellText` / `isEditStale`（P-21 批次 C 的 R5）；**提示条的迁移** `noticeAfterDispatch` / `rejectionNotice` / `StatusNotice`（P-30，唯一实现处） |
| `gesture.ts` | 拖拽手势的**纯内核**（ADR 0008 §4–§8 + **§13**）：屏幕坐标归一化 `pointerFromClient`、条体命中 `barHitFor`、命中反算 `resolvePointerTarget`、入边约束 `entryConstraintFor`、吸附 `snapCandidate`、位移与候选 `deltaFor` / `candidateOrdinalFor`、判定区 `dragModeFor`、状态机 `beginGesture` / `reduceGesture`、结果解析 `resolveDragOutcome`、预览几何 `dragPreviewFor` |
| `zones.ts` | **判定区的唯一公式**（ADR 0008 §16.1／[P-32](../../docs/00-baseline/裁决记录.md)）：`zonesFor`（随条宽收缩）、`zoneAt` / `zoneContains` / `dragModeOfZones`、`cursorForZone`、`translateZone` / `translateZones`，以及建线四格表 `linkTypeFor` / `linkEnterSideFor` / `exitXFor` / `enterXFor`。**单独一层**：公式的消费者在环上（`gesture` 要语义、`interaction` 要手柄与光标） |
| `interaction.ts` | **交互几何**（ADR 0008 §16.2/§16.3，**落点与可见性按 §16.7 的人工复验返工**）：`rowHandlesFor`（端点手柄 2×4 px + 两侧连接点，内缘贴条端、竖向居中）、`handleXFor`、`barHeightOf`、`connectSideAt`（**显示区 ⊇ 命中区**）、`connectRevealFor` / `rowConnectVisibleAt`（按需显形）、`cursorForPointer`（光标枚举）、`linkEntryFor`（建线起手位置）、`handleOffsetsFor`（记录制核对） |
| `highlight.ts` | 交互态高亮（**不进 `ViewModel`**）：成环路径、选中、冲突、建线端点；`affectedRenderSetWithAnchors`（拖动期的渲染侧最小重建） |
| `affected.ts` | `affectedRenderSet`：受影响行 + 受影响边（编辑重绘的判据） |
| `align.ts` | **两栏行对齐的判读内核**（ADR 0007 §14/§15 / [P-23](../../docs/00-baseline/裁决记录.md)、[P-24](../../docs/00-baseline/裁决记录.md)）：`diagnoseRowAlignment`（一次探测）+ `summarizeAlignment`（多位置汇总）；判据含**轴的四边覆盖**与**滚动范围**（`content-range-mismatch`）。输入全是**视口坐标的数字**（DOM 采数在 `apps/web/src/measure.ts` 的记录制钩子里）。机制标签见 ADR §14.4 |
| `fixtures.ts` | 确定性夹具生成（演示 / 测量 / spec 同源） |

**主入口**

```ts
buildView({
  document: ProjectDocument,
  schedule: Schedule,
  calendar: Calendar,          // 必须来自 createScheduleCalendar(document)
  viewport: Viewport,          // scrollTop / scrollLeft / width / height / rowHeight / rowBuffer
  zoom: 'day' | 'week' | 'month',
  clipMode?: 'intersect' | 'endpoints' | 'none',   // 后两者只作负向对照
}): ViewModel
```

**一处有意偏离 ADR §2**（已由 G4-S 记载并继承）：ADR 写的是 `ordinalAtX(view, x)`，
而"序号"只有 `Calendar` 能算。为了让 `ViewModel` 保持"只有数字与枚举"，
本包把日历作为**显式入参**：`ordinalAtX(view, x, calendar)`。语义与 §3 的分工不变。

## 三、时间轴与 x 坐标（本块最重要的口径）

**x 轴按「自然日连续」排列**，非工作日照常占位并视觉区分；工期/序号语义仍是工作日。

**反算的坐标口径（ADR 0007 §16 / 裁决 P-25）**：`dayAtX(view, x)` / `ordinalAtX(view, x, calendar)` 的 `x`
是**内容坐标**（与 `row.xLeft/xRight`、`bounds`、`points` 同一坐标系），因此**不含** `scrollLeft`：
屏幕坐标必须先经 `pointerFromClient` 归一化（ADR 0008 §15）。反算公式**只允许一处**（`dayAtX`）。
同理 `resolvePointerTarget` 的 `y` 是内容坐标，**不得**再加 `scrollTop`。
**所有坐标换算类判据至少要取一个非 0 滚动位置**（P-25：R13/R14 只在滚动后现形）。

```
axisOriginDay = dayOfOrdinal(projectStart) 按档位向前取整到该档位起点 − AXIS_LEFT_GUTTER_DAYS
xLeft(i)      = (dayOfOrdinal(es[i])             − axisOriginDay) · pxPerDay
xRight(i)     = (dayOfOrdinal(ef[i] − 1) + 1     − axisOriginDay) · pxPerDay
```

- **右边界必须 `ef − 1` 再 `+1`**：`ef` 是**排他**结束序号，跨周末的任务（周五 + 周一）
  用 `dayOfOrdinal(ef)` 会多出一整段空隙；
- **汇总条**同规则，取 `summaryEs` / `summaryEf`；
- **里程碑**（零时长叶子）：几何上以所在工作日**格的中点**（`+0.5` 天）为中心画菱形，
  边长 = 行高 × `SPACING.milestoneSizeRatio`——**视觉约定**，不改变"零时长"语义。
  这条同时是 `ef === 0` 时唯一合法的路径（§11.1 ①：`dayOfOrdinal(-1)` 会抛错）；
- **轴线起点**：按档位向前取整（日档 = 当天；周档 = 该周周一；月档 = 该月 1 日），
  再向左留 `AXIS_LEFT_GUTTER_DAYS`。**左边距不是装饰**：P-8 的 SS/SF"左出回绕"走线需要它；
- **档位只改 `pxPerDay` 与表头分组**，不改变任何序号 ↔ 日期的对应；切换是**离散**的；
- **序号 → 日期必须用同一个 `createScheduleCalendar(document)`**，否则容量不足时 `isoOfOrdinal` 会抛错。

## 四、行模型

**两栏行屏幕几何同一式**（ADR 0007 §14 / P-23）：

```
行屏幕 y = 列顶 + HEADER_HEIGHT_PX + row × ROW_HEIGHT − scrollTop
```

- `HEADER_HEIGHT_PX = 28`（`manifest.ts` 单点声明）= 左表表头与图表表头带的**外高**（两栏 `box-sizing: border-box`）；
- **绘制区 = 滚动容器客户区**：`Viewport.height = clientHeight`（§2 的 `scrollTop // 不含表头` 由此字面成立）；
- **行外高必须 = `ROW_HEIGHT`**：`.row` 若在 `content-box` 下加 1 px 下边框，外高成 25 px ⇒ 每行漂 1 px（R9）；
- 图表行的 `<g>` **没有自己的盒子**，`getBoundingClientRect()` 是子元素（条 / 菱形）的并集，
  而条在行内垂直居中 ⇒ 对齐判据取**条中心 = 行中心**，不取行顶。

**内容横向范围与轴**（ADR 0007 §15 / P-24）：

- `ViewModel.contentWidth` = 滚动范围（spacer 宽）的**唯一真相源**：
  `max(窗格宽, 最末任务右缘 + EDGE_STUB_PX + EDGE_WRAP_PX + CONTENT_RIGHT_PAD_PX)`，
  最末任务右缘来自 `Schedule.projectFinish`（**不得**按窗格宽外推——那会让大项目只能滚开头几十天）；
- **轴的 `x` 是窗口坐标**（`buildAxis` 已扣 `scrollLeft`、只发射视口内的元素，§6.1 ③）：
  因此轴必须渲染在**滚动组之外**（放进滚动组就是横向双重偏移，`scrollLeft = 0` 处不可见）；
- SVG 覆盖**整列**：`svgHeight = height + HEADER_HEIGHT_PX`，盒 = `viewBox`（1 单位 = 1 px）；
  色带/网格线整体下移 `HEADER_HEIGHT_PX`（落到绘制区），日期刻度画在表头带内（0..28）。

| 项 | 冻结内容 |
|---|---|
| 行的真相源 | 可见行序列 = 树序（文档序，父先于子）经**折叠过滤**后的子序列；`Schedule` 的数组仍按**文档序**索引（不压缩），渲染层负责两次映射 |
| 行高 | **固定**（虚拟化的前提）；折叠/展开**不得改变行高假设**，只改变行数 |
| 折叠状态 | 文档字段 `collapsed`，变更经 **`task.update`** ⇒ 折叠/展开天然可撤销；折叠态**不随 xlsx 往返** |
| 汇总行 | `es[i] === -1`；进度取 `summaryProgress`，**`NaN`（子树工期权重和为 0）时不画进度填充**，不是 0% |
| 进度 | 叶子取文档 `progress`（`null` 视为未知 ⇒ 不画填充） |
| 空汇总 | 没有叶子后代（`summaryEs/ summaryEf` 仍为 `-1`）⇒ **不产出行**（没有可画的区间） |

## 五、依赖线的路由几何

- **出/入边策略的唯一登记处是[裁决 P-8](../../docs/00-baseline/裁决记录.md) 第 1 条**
  （FS 右出→左入、SS 左出→左入、FF 右出→右入、SF 左出→右入；左右连接点 = 该边中点）。
  本包只放它的**可执行副本**（`ROUTE_SIDES`），**不重述成第二处真相源**；
- 参数化折点：每条边一律「**出端水平 stub → 竖直段 → 入端水平 stub**」，折点全部正交；
  - `EDGE_STUB_PX` = **8 px**：**固定像素，不随 `pxPerDay` 缩放**（以免缩放时折点跳变，
    并让 G7 在给定 `pxPerDay` 下拿到同一几何）；
  - 竖直段 x：常规情形 = 两端 stub 末点的**中点**；**需要回绕**（左出且目标 stub 在出端 stub 左侧
    —— 即 SS/SF 且目标在前置左侧）取 `min(两端 x) − EDGE_WRAP_PX`（12 px），落在左侧 gutter 内；
  - **规则固有的不连续性**：回绕判据会随 `pxPerDay` 变化而翻转（G4-S 实测 120 条样本里 2 条）。
    要消掉它只能改规则（**另立 ADR**），不是实现缺陷；
- **4 类关系的箭头必须可区分**：判据是"给定同一对条，4 类关系的箭头形态两两不同"。
  形态 = **填充**（FS/FF 实心、SS/SF 空心）× **朝向**（左入 ⇒ +x、右入 ⇒ −x）；
  真实尺寸 12 × 7.2 px（行高 24），两两 Jaccard 距离最小 **0.3023**（阈值 0.15）——
  **同尺量化，不得目视**（P-9 方法论）；
- **同侧多线分道/避让 v0.1 不做**（P-8 遗留 3）。G4-S 已量化触发依据
  （70.7% 的边其竖向段穿过条形，最小间距 −264 px）；出现真实取舍时**另立 ADR**；
- SVG 工程细节：`shape-rendering="crispEdges"`；缩放线宽用 `vector-effect="non-scaling-stroke"`；
  交互热区必须是**独立透明 `<path>`**，不得给可见图元加大热区。

## 六、裁剪契约（纯 SVG 路线唯一的失败模式）

1. **行窗口裁剪**：渲染行 = 可见行 + 上下各 `ROW_BUFFER`（5）行；
2. **边窗口裁剪：必须用「边所跨行区间 ∩ 渲染窗口」求交。**
   仅按"两端点是否可见"裁剪会**错误隐藏跨屏长箭头**——G4-S 实测在 4 个滚动位置
   误裁 **33 / 97 / 96 / 88 = 314** 条（其中跨屏长边 268）；
   「边所跨行区间」= 两端点**可见行序号**的闭区间；
3. **折叠隐藏的行不画其边**（否则出现指向不存在行的悬空线）——与第 2 条**同一遍**完成：
   隐藏行没有可见行序号，端点映射为 `-1` ⇒ 该边被排除；
4. **文档里的全部 `links` 都画**（含端点为汇总任务、被传播忽略的边）。与被传播忽略的边
   用样式键 **`edge-ignored`** 区分（§11 第 7 项），**不新开诊断码**（诊断码表仍是闭集）；
5. **裁剪先于几何计算**；
6. **拖拽期不做逐帧 DOM 重建**（G5 复用本条）；
7. **元素预算可测**：`#elements ≤ c₁ · visibleRows + c₂ · visibleEdges + c₃`
   （`c₁ = 3`、`c₂ = 3`，`c₃` = 轴元素数，逐档位一个常数）；
8. **负向对照必须存在**（否则第 7 条可能是恒真式）：把求交换成端点可见性裁剪必须被检出丢边；
   关掉窗口裁剪必须被检出元素数随规模增长。

### 6.1 三条口径澄清（ADR §11.1，只澄清不改语义）

1. **右边界公式在 `ef === 0` 时未定义** ⇒ 里程碑走菱形分支（§三）；
2. **§6.2 的"可见行窗口"读作 §6.1 的渲染窗口**（可见行 + `ROW_BUFFER`），
   否则缓冲行内出现的边会被漏画，与 §6.1 自相矛盾；
3. **轴与刻度还有第三维：水平窗口**——只发射视口 x 范围内的刻度与色带，
   因此 `c₃` 只与"视口宽 ÷ `pxPerDay`"有关，**与文档总规模无关**。

## 七、状态与退化

| 状态 | 渲染行为 |
|---|---|
| `compute` 失败（`ok: false`，`code: 'cycle'`） | `buildView` 的调用方**不画条形与连线**，渲染"不可排程"占位；本包不产出 `ViewModel`（因为拿不到 `Schedule`） |
| `undated` / `clampedStart` / `dateOverridden` / `endDateStale` 等诊断 | **G4 不做任何诊断 UI**（不画徽标、不画角标）——呈现是 G5 的 G-8/IX-04 范围；G4 只保证"有日期可画、没日期不崩" |
| 无日期任务（回落项目起点） | 照常按 `es` 画（序号已被截断到项目起点），不特殊标记 |
| 空项目 / 全汇总 | 只画刻度与左表，不画条形；**不得出现 `NaN` 坐标** |

## 八、编辑的边界与重绘

- **行内编辑只走 `task.update`**（含 `collapsed`）；`task.insert`/`task.remove`/`task.indent`/
  `task.outdent`/`task.move`/`link.*` 的**交互入口**归 G5/G6；
- **编辑后的重绘走"受影响行 + 受影响边"**：`affectedRenderSet(document, changedTaskIds)`
  = `affectedClosure()` 的后继闭包 **＋ 沿 `parentId` 补的祖先链**
  （[`SCHEDULE.md` §八](../engine/SCHEDULE.md) 已声明"闭包不含祖先"是已知边界），
  边取"任一端点受影响"的全部边（边的几何只由两端点决定）；
- **折叠/展开会改变可见行集合**，因此窗口必须重算——这不是"整表重建"
  （出口条件禁止的是**行内编辑**触发整表重建）；`v-for` 的 `key` 仍是任务 id，DOM 复用不受影响；
- **编辑态只在"该任务该列的原始值真的变了"时结束**（P-21 批次 C 的 R5）：判据是纯函数
  `isEditStale({ before, after, taskId, column })`（`viewText.ts`，**进 `pnpm gate`**），
  比较的是 `rawCellText` 的**原始字段文本**（任务消失 ⇒ `undefined` ≠ 旧值 ⇒ 陈旧）。
  观察点是**文档身份**而不是 `revision` 数字；行被折叠隐藏或滚出渲染窗口**不算**变化（草稿保留）。
  原先"任何版本变化都取消编辑态"使"编辑态优先"（ADR 0008 §10）事实上不成立；
- 撤销/重做 UI 在 `apps/web`（G5 已落地），命令回退栈的持久化归 G6。

## 八之二、拖拽手势与交互态（G5，ADR 0008 §4–§11 + **§13** + **§14**）

- **纯内核在 `gesture.ts`**：入参是**归一化指针**（`{x, y, buttons, altKey, escPressed}`，
  内容坐标；绝不出现 `MouseEvent`），出参是 `{ state, anchors, commands, link, rows, edges, cyclePath, preview }`。
  `apps/web` 的 `useGesture.ts` 是**唯一碰 DOM 的手势代码**；
- **屏幕坐标 → 内容坐标只有一条路**（ADR 0008 §13；P-22 批次 A 的 R1）：
  `pointerFromClient({clientX, clientY, paneLeft, paneTop, scrollLeft, scrollTop, buttons, …})`，
  即 `x = clientX − paneLeft + scrollLeft`。**禁止** `MouseEvent.offsetX/offsetY`——它们相对**事件目标元素**，
  `mousedown` 落在条体上时会被当成内容坐标；
- **命中条体是判定区的前提**（§13；R2）：`beginGesture` 要求
  `x ∈ [xLeft − HIT_TOLERANCE_PX, xRight + HIT_TOLERANCE_PX]`（`HIT_TOLERANCE_PX = 2`），
  否则 `idle`；里程碑用**菱形包围盒**；**竖向不设限**（行即竖向单位，ADR 0007 §4）——
  因此"同一行的空白处按下"不再改日期；
- **三语义判定区**（`DRAG_EDGE_PX = 6`）：条的左端 ⇒ 改开始（完成日不动、工期随之变）、
  右端 ⇒ 改工期、中部 ⇒ 整体移动；**里程碑按菱形中心分半**（只有整体移动与"改工期"两支）；
  汇总行**不可拖**（汇总日期是聚合结果）但可作为建线端点；
- **候选序号是"抓取点相对"，且按模式分别定义**（§13；R7）：
  `delta = ordinalAtClamped(view, pointer) − state.grabOrdinal`（`grabOrdinal` = **按下那一刻**的序号），
  `move`/`resize-start` 的候选 = `originOrdinal + delta`（新**开始**）、
  `resize-duration` 的候选 = `originOrdinal + max(1, D) − 1 + delta`（新**完成**）。
  **基准必须取"被拖任务在按下时捕获的序号"**，不取"指针当前所在行"（拖动期视图带着锚点重算，
  后者会累积成加速拖动）；**零位移不产出命令**；**零时长的完成日 = 开始日**；
- **拖动期不写文档**：位置经**会话锚点**（`compute(document, calendar, anchors)`）生效，
  松手才提交**一条**命令；`Esc` 取消 ⇒ 清锚点、不提交（⇒ IX-03 的"一次手势 = 一层撤销"）；
- **`snap` / `allow`**：`snap` 把**开始**语义的候选夹到 `[0, 入边约束]`（`snapCandidate`），
  `resize-duration` 不夹取；`allow` 原样放行。**冲突判据只有 `compute` 的 `anchorConflict` 一处**——
  "晚于约束"不是冲突（`ES = max(约束, 锚点)`），"**早于**约束"才是（SCHEDULE.md §四.3 情形④）；
- **预览与提交同源**（§13）：`resolveDragOutcome({state, document, calendar})` 是锚点/预览/松手 patch 的
  **唯一**来源；覆盖层用 `dragPreviewFor(...)` 画**结果轮廓**（`resize-duration` 拖动期条体本体不动，
  会话锚点形状不扩）；判据是"预览区间 == 落库 + `compute` + `taskBounds` 之后的区间"；
- **建线**：类型由相对位置反推（`to.xLeft ≥ from.xLeft ⇒ FS`，否则 `SS`）、`lagDays = 0`、
  id 由本包给确定性建议值；**成环预检即拒绝**并把 `path` 交给高亮层；
- **高亮是独立覆盖层**（`highlight.ts`）：**不进 `ViewModel`**——几何真相源只由
  「文档 + `Schedule` + `Calendar` + 视口」决定，交互态进去会让期望值表与裁剪判据跟着手势漂移；
- **元素预算**：覆盖层另立 **`c₄`**（`ELEMENT_MODEL_G5.overlay = 12`，**每帧固定开销**），
  `c₁`/`c₂`/`c₃` 一字未改；`countElements` 与 `countElementsByEnumeration` 对覆盖层同样逐项互证。
  批次 A 只改覆盖层的**坐标**（预览几何），**不新增元素** ⇒ `c₄` 不变。

## 九、验证与门禁

> **本表是判据的登记处**（分层规范见 [`docs/DOC-SPEC.md`](../../docs/DOC-SPEC.md) §一）：
> 一行一条判据，去掉按轮次重复的行。**逐轮的过程细节**（每批改了什么、四条/五条负向对照的实测、
> 三轮人工复核的报文与判定）不在这里复述，指向 [首版-记录-G5](../../docs/01-roadmap/首版-记录-G5.md) 与
> [ADR 0007 增补](../../docs/02-adr/附录/0007-增补.md)、[ADR 0008 增补](../../docs/02-adr/附录/0008-增补.md)。
> 列「增补记录」标出该行来自哪一轮裁决。

| 层 | 手段（住哪个 spec） | 判据（只搬不改） | 进 `pnpm gate`？ | 增补记录 |
|---|---|---|---|---|
| ① 几何期望值表 | `geometryExpectations.spec.ts`（声明式，内核无权改基准） | 13/13 条；NC3 三条变造必须被检出 | **进** | — |
| ② 裁剪结构断言 | `clipping.spec.ts` + `scaleInvariance.spec.ts` | 12 组预算全过；元素数与规模解耦（10× 规模 → 1.104×）；跨屏长边不被误裁 | **进** | — |
| ③ 不变量 | 同 ① ②（反算往返、端点贴合、汇总覆盖、哨兵守卫） | 全过 | **进** | — |
| ④ 负向对照 | NC1（端点可见性必须丢边 314 条）、NC2（关裁剪必须增长 10.71×）、NC3 | 必须被检出 | **进** | — |
| ⑤ 浏览器计时 | `scripts/measure-render.mjs`（零依赖 CDP，**打包产物**） | 1,000 任务首屏 ≤ 1s；10× 滚动与《评估报告》§5.4 同尺 | **不进**（记录制，P-17） | — |
| ⑥ 人工目视 | 仅备查 | "吸附/走线类判断必须量化，不得目视" | **不进** | — |
| G5 ① 日期口径（P-19） | `dateText.spec.ts` + `dateTextNegative.spec.ts` + `editCommand.spec.ts` + `textFixtures.spec.ts` | 开始 ≤ 完成、与 `Schedule` 同源、派生完成与显示的"开始"同源、编辑写回一致；**NC1/NC2 必须被检出** | **进** | [P-20](../../docs/01-roadmap/首版-记录-G5.md) |
| G5 ② 手势与三语义（P-20） | `gesture.spec.ts` | 三语义判定区、拖动三情形与松手命令、`Esc` 取消、汇总不可拖、`snap`/`allow` 四象限与 `anchorConflict` 对齐、建线与检环、命中反算 × 三档位；**屏幕坐标 → 内容坐标与事件目标无关**（含 NC）、条体命中 ± `HIT_TOLERANCE_PX`（含里程碑包围盒）、三语义**零位移不产出命令**、`move` 中部抓取**不跳位**、`resize-start` 完成日不动、`resize-duration` 按下**不翻倍**、里程碑完成日 = 开始日、**预览与提交同源**、带**会话锚点**重算**不累积**（13 → 24 例；五组负向对照逐条验证过判别力） | **进** | [P-22](../../docs/01-roadmap/首版-记录-G5.md) / [ADR 0008 §13](../../docs/02-adr/附录/0008-增补.md) |
| G5 ③ 依赖方向护栏 | `boundary.spec.ts` | 本包发布源与**构建产物**都没有指向 `exceljs` 的模块边；本包铁律夹具被拦下 | **进** | — |
| G5 ④ 拖动计时 | `scripts/measure-render.mjs --drag` | 帧间隔 p95 ≤ 33.3 ms（≥30 fps）、松手 → 重算 + 冲突标记 ≤ 200 ms、下游跟随、**位移**（松手后 `startDate` = 按下时的开始序号 + 天数） | **不进**（记录制，ADR 0008 §11） | [P-22](../../docs/01-roadmap/首版-记录-G5.md) |
| G5 ⑤ 导入与成环清单（第 13 条） | `scripts/measure-render.mjs --import=<xlsx>` + `scripts/make-sample.mjs` | 成环样本 ⇒ 6 任务 / 5 依赖 / 恰 1 条 `XLSX_CYCLE_EDGE_DROPPED`（带成环路径）/ 无"不可排程" | **不进**（记录制） | [P-22](../../docs/01-roadmap/首版-记录-G5.md) |
| G5 ⑥ 两栏行对齐判读（P-23 / P-24） | `align.ts` + `align.spec.ts`（**20 例**） | 正例"未变造时零检出" + **每条机制一条负向对照**（③双重偏移 / ②缺表头带 / ①测量过期 / R8 盒≠viewBox / R9 行外高 / 表体高 / 表头高 / 轴纵向或**横向**不覆盖 / **刻度侵入第一行** / **R11 滚动范围** / 单行漂移 / 滚动不同步 / 所见≠所点 / 空白带 / 空样本） | **进** | [记录层](../../docs/01-roadmap/首版-记录-G5.md) / [ADR 0007 §14–§15](../../docs/02-adr/附录/0007-增补.md) |
| G5 ⑥ 两栏行对齐（真实 DOM） | `scripts/measure-render.mjs --align[=<label>]`（**左表在场**） | **6 个 (top,left) 位置**（含 0 与 `maxScroll` 两个方向）逐行 \|Δ\| ≤ 0.5 px；`pinned`/`svgBoxAligned`/`headerAligned`/`heightAligned`/`rowHeightAligned`/`scrollInSync`/`contentRangeAligned`/`labelsInHeader`/`hitTestOk` 全真；空白带 0；轴四边覆盖 + 刻度在表头带内 | **不进**（记录制，需本机 Chrome） | [P-23](../../docs/01-roadmap/首版-记录-G5.md) / [P-24](../../docs/01-roadmap/首版-记录-G5.md) |
| G5 ⑦ 拖动期画的是结果（P-24） | `gesture.spec.ts`（24 → 26 例） | 三语义下 `drawnBarForRow` == 落库重算后的 `taskBounds`；与**锚点视图**的对照（`resize-start` 的右端固定）；未被拖行不受影响 | **进** | [ADR 0008 §14](../../docs/02-adr/附录/0008-增补.md) |
| G5 ⑧ 滚动状态下的反算与命中（P-25） | `geometryExpectations.spec.ts`（+3 例）+ `gesture.spec.ts`（+1 例） | **滚动视图**（`scrollTop=480/scrollLeft=600`）下：反算往返与端点贴合与不滚动时**逐值一致**；条左缘仍映射到 `es`；命得中同一行、起得了手势；候选与抓取点的**工作日差** == 指针移动的工作日差 | **进** | [ADR 0007 §16](../../docs/02-adr/附录/0007-增补.md) / [ADR 0008 §15](../../docs/02-adr/附录/0008-增补.md) |
| G5 ⑧ 滚动状态下的拖动（记录制） | `scripts/measure-render.mjs --drag` | **两个滚动状态各一次**（`(0,0)` 与 `(480,600)`）：各自的"松手后 `startDate` = 按下时的开始序号 + 天数"都必须成立；目标行必须**无有效入边约束**（否则 `snap` 夹住候选 = 假红） | **不进**（记录制，需本机 Chrome） | [P-25](../../docs/01-roadmap/首版-记录-G5.md) |
| G4/G5 ② 内容横向范围（P-24） | `viewModel.spec.ts`（16 → 19 例） | `contentWidth` 覆盖**全部任务最右缘** + 引出段 + 回绕走廊；随项目末端单调；空文档回落窗格宽；**负向对照**：旧式"按窗格宽推导"必须不满足 | **进** | [ADR 0007 §15](../../docs/02-adr/附录/0007-增补.md) |
| G5 ⑨ 编辑态"值真的变了才取消"（P-21 批次 C） | `editCommand.spec.ts`（**+10 例**） | `rawCellText` 逐列**原始字段**（`null` ⇒ 空串、任务不存在 ⇒ `undefined`、派生列 ⇒ 空串）；"别的任务变了 / 同任务别的列变了 ⇒ **不**陈旧"、"该任务该列真的变了（文本列 + 日期列）⇒ 陈旧"、"任务消失 ⇒ 陈旧"、"改回原值 ⇒ 不陈旧"；恒等 patch 必须 `changed === false`（前提自证）；**NC1**（忽略 `column`，只比整个任务）与 **NC2**（旧规则"任何版本不同即陈旧"）必须被检出 | **进** | [P-28 批次 C](../../docs/01-roadmap/首版-记录-G5.md) |
| G5 ⑨ 提示清空（P-21 批次 C） | 人工复核 + 临时 CDP 预验（**打包产物**口径，M1–M7） | 空栈 `Ctrl+Z` 出现的 `SESSION_NOTHING_TO_UNDO` 在**下一次成功且真的改了文档的命令**后消失——**含拖动/建线的松手提交**（P-31）；`apps/web` 至今没有判据入口 ⇒ DOM 层只能人工验（P-9 口径） | **不进**（人工） | [P-28 批次 C](../../docs/01-roadmap/首版-记录-G5.md) / [P-31](../../docs/00-baseline/裁决R30.md) |
| G5 ⑩ 提示条的迁移（P-30，收口 P-29） | `editCommand.spec.ts`（**+5 例**）；**落点在 `useProject.commit()`**（`apps/web`，不进 gate） | 三档逐条：**失败**才产生提示（文案含 `code`/`message`，缺失用「未知」）；**成功且 `changed`** ⇒ 清掉失败提示、`info` 不动；**成功但 `changed === false`** ⇒ 原样保留。含一条**用真实会话栈**跑维护者报文序列：空栈回退 ⇒ 有提示；修改 ⇒ 提示消失；回退到栈底 ⇒ 不出现；栈底再回退 ⇒ 才重新给提示。**落点在命令通道**（P-31）：`dispatch`/`undo`/`redo`/`ingestDocument` 都经 `commit()`，任何调用点都绕不过 | **进**（规则本体） | [P-30](../../docs/00-baseline/裁决R29.md) / [P-31](../../docs/00-baseline/裁决R30.md) |
| G5 ⑪ 判定区随条宽收缩、端点手柄与连接点（P-32＝P-21 批次 B） | `zones.ts` + `interaction.ts` + `interaction.spec.ts`（**新增 22 例**）+ `gesture.spec.ts`（**+6 例**） | `zonesFor` 的边界公式：宽条（≥18 px）与旧式 `DRAG_EDGE_PX = 6` **逐值一致**（前提自证）、9 px 条给出 6 px 的 `move` 区、3 px 条（月档 1 个工作日）的 `move` 区**非空**（**NC1**：固定 6 px ⇒ 空集）；手柄 x **= 判定区边界**（与判定区同源）、连接点**内缘贴条端、整体向外伸**（竖向中心 = 条形中心；**显示区 ⊇ 命中区**：方块的每一处都点得中）、`connectRevealFor` 只在指针靠近该行条端时显形、手柄高 4 < 条高 14.4（不越过条体上沿）；光标四分类（端点 `col-resize` / 中部 `move` / 连接点 `crosshair` / 其余 `default`，且**取非 0 滚动位置**）；`linkEntryFor` 的 `exitSide` = 所抓那一侧、`linkTypeFor` 四格与端点 x（**NC2**：连接点 x 换成手柄 x ⇒ 从"建线"退化成"改工期"）；`handleOffsetsFor` 与 `rowHandlesFor` 同源 | **进** | [ADR 0008 §16](../../docs/02-adr/附录/0008-增补.md) / [P-32](../../docs/00-baseline/裁决R31.md) |
| G5 ⑪ 手柄/光标/连接点（记录制） | `scripts/measure-render.mjs --drag` | 打包产物上：DOM 手柄条数 **= 模型**（`handleOffsetsFor`）、**指针所在那一行的连接点 = 2**（按需显形）、条体中部/端点/连接点三处的光标分类正确、**从连接点按下认得出该侧入口**（R4 的可判定形式） | **不进**（记录制，需本机 Chrome） | [P-32](../../docs/01-roadmap/首版-记录-G5.md) |
**元素预算的常数与实测**（[`apps/web/evidence/render-timing-chrome152.md`](../../apps/web/evidence/render-timing-chrome152.md)）：

- `c₁ = 3`（每渲染行：`<g>` + 条 + 进度；里程碑行 2；**汇总条不加端帽**）、
  `c₂ = 3`（每条渲染边：折线 + 箭头 + **透明热区**）；
- **`c₄ = perRenderedRow·rows + overlay = 6·rows + 12`**（ADR 0008 §16.4／[P-32](../../docs/00-baseline/裁决R31.md)）：
  每渲染行 6（条/菱形 1 + 进度 1 + 端点手柄 2 + 连接点 2 的**上界**，最"胖"的是有进度的叶子）+
  每帧固定 12（拖动轮廓 3 / 建线预览 2 / 冲突描边 1 / 成环与选中高亮 ≤ 6）。
  **"与文档总规模无关"不变**：`rows ≤ 视口行数 + ROW_BUFFER`，10× 规模下 `rows` 恒为 32
  （实测锚值随之平移：`scaleInvariance.spec.ts` 由 `350 / 317 / 329 / 335` → `472 / 439 / 451 / 457`，
  逐项差值恒为 **122**；`clipping.spec.ts` 的 NC2 比值由 10.71× → **≈10.8×**）；
- `c₃` 逐档位 = **114 / 69 / 88**（日/周/月，图表全宽 1265 px），与 ADR §11 回填的
  **116 / 70 / 89**（图表独占 1280 px）差 1–2——就是那点宽度差；
- 分屏时图表窗格被左表占去一部分宽度，同一页面下 `c₃` 只有 35 / 21 / 26：
  **`c₃` 只取决于"窗格宽 ÷ `pxPerDay`"，与文档总规模无关**（§11.1 ③ 的直接后果）。

**维护纪律**：改 `apps/web` 的 SVG 模板时，必须同步 `ELEMENT_MODEL` 的 `c₁`/`c₂`
（G5 若给行加交互热区，**必须另加常数**），并让 `countElements` 与 `countElementsByEnumeration`
继续逐项相等——否则"元素数与文档总规模解耦"这句话就失去了载体。

**夹具口径**：1,000 任务 / 1,500 依赖（三种形态：宽而浅 / 深链 / 密集交叉），
外加 2,200 边的"§5.4 同尺对照"数据集；全部由 `fixtures.ts` 的确定性生成器产出
（零 `Math.random`、边一律沿文档序向前、精确命中声明的规模）。

## 十、明确不做（v0.1 内）

- **季刻度**与折叠展开**动画**；
- **同侧多线分道/避让**（P-8 遗留 3，另立 ADR 才做）；
- **导出路径的窗口裁剪**：导出是**全量渲染**，G7 只复用 §2/§3/§5 的几何，**不复用 §6**；
- **Worker 化**、**2,000 任务正式压测**、**无障碍基础**（虚拟化的 `aria-rowcount` / `aria-rowindex` 一并延后）、
  **主题跟随**（v0.5）；
- **Tab/Shift+Tab 调级**（P1-07 → v0.5）；
- **拖动期的边缘自动滚动**（指针移出窗格时不滚动，ADR 0008 §11）；
- **诊断的行内徽标/悬浮卡**：G5 只交"三层拼接清单 + 冲突描边 + 成环高亮"的**受控收口**（ADR 0008 §9）。
