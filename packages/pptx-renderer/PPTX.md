# PPTX 渲染规范（G7）

> 本文件是 `@ganttpilot/pptx-renderer` 的**权威规范**（与 [`engine/SCHEDULE.md`](../engine/SCHEDULE.md)、
> [`render-core/SPEC.md`](../render-core/SPEC.md)、[`xlsx-protocol/PROTOCOL.md`](../xlsx-protocol/PROTOCOL.md) 同构）。
> 契约出处：[ADR 0010 导出契约](../../docs/02-adr/0010-导出契约.md)（**冻结面**）；
> 准入实验：[S-G7 四条门禁（依据）](evidence/g7-s7-a-b-wps.md)（跨组吸附 / `custGeom` / 字节确定性 / 适配数值）；
> 前史：[S1 结论](../../spikes/g0-s1-pptx-connector/结论.md)（connector 吸附形态与 WPS 口径的原始实证）。

## 一、四条铁律

1. **零 DOM、零框架**：本包只用 `pptxgenjs`（容器 + 文本）+ `jszip`（打补丁）与两个 workspace 包；
   **只允许 `outputType: 'uint8array'`** —— `Blob` / `URL` / `canvas` 一律留在 `apps/web`。
2. **几何只有一个作者**：幻灯片上的每个坐标都由本包从 `render-core` 的 `ViewModel` 推出；
   `pptxgenjs` 只造容器与文本，**不参与几何**（库升级不会挪动我们画出来的位置）。
3. **形状名是唯一定位锚点**：`name → id` 从**容器实测**解析（`parseShapeRefs`），
   `IdAllocator` 分配新 id；**绝不硬编码 `id = idx + 2`**（那是 pptxgenjs 的实现细节）。
4. **归一化产出**：`docProps/core.xml` 的时间字段 + 全部 zip 条目日期固定 ⇒ 同一输入**逐字节一致**（§四）。

## 二、包边界与公共 API

| 模块 | 职责 |
|---|---|
| `units.ts` | **单位与常量的唯一真相处**：`px → pt → EMU`（整数化）、16:9 页面常量、字号、颜色 |
| `ooxml.ts` | OOXML 片段构造与解析：`<p:sp>`（条/进度/菱形）、`<p:cxnSp>`（双端吸附）、`<p:grpSp>`（一级组）、`<a:custGeom>`（降级折线）、站点表、`spTree` 注入、`name → id` 解析与 `IdAllocator` |
| `template.ts` | **模板 A**：布局（纯函数 `planTemplateA`）、容器构建、补丁注入、归一化、`p:sldSz` 读回断言 |
| `fingerprint.ts` | 产物指纹（`bytesEqual` / `crc32Hex` / `entryDigests` / `diffDigests`；**不含 `node:crypto`**） |

**主入口**

```ts
renderTemplateA({
  document: ProjectDocument,
  schedule: Schedule,
  calendar: Calendar,          // 必须来自 createScheduleCalendar(document)
  zoom: 'day' | 'week' | 'month',
  title?: string,              // 默认取 document.project.name
  degradeConnectors?: boolean, // true ⇒ 用 custGeom 折线（ADR 0010 §6 的降级②）
}): Promise<Uint8Array>
```

## 三、形状映射与吸附站点（ADR 0010 §5）

| 语义 | 形状 | 形状名 | 备注 |
|---|---|---|---|
| 任务条 | `prstGeom prst="roundRect"` | `bar-<taskId>` | 蓝色 `2E75B6` |
| 阶段汇总条 | `prstGeom prst="rect"` | `bar-<summaryId>` | 灰 `7A8699`、更矮（`SPACING.summaryBarHeightRatio`） |
| 进度 | `prstGeom prst="rect"` | `prog-<taskId>` | 深蓝 `1F4E79`，左缘对齐、高内缩 2 px |
| 里程碑 | `prstGeom prst="diamond"` | `ms-<taskId>` | 橙 `ED7D31` + 描边 |
| 依赖线 | `<p:cxnSp>` + `bentConnector3` | `dep-<linkId>` | 双端吸附 + **`a:tailEnd` 箭头**（见下） |
| 一级组 | `<p:grpSp>` | `grp-<summaryId>` | 汇总行 + 其**直接**子行形状 |
| 周末/节假日**灰度带** | 无描边 `rect` | `band-<n>` | `F4F6F8`；与 SVG 的 `view.axis` 的 `band` 同源。**画在月份正文底之上**（G8 人工复验第 ④ 条：后者整高且月段首尾相接，压在它下面就再也看不出"哪几天不上班"） |
| **上级分段带·正文** | 无描边 `rect` | `major-band-<n>` | `FAFBFC`（**近乎白**：它整高覆盖全宽，不能与灰度带抢对比度——首版的 `EEF1F5` 与周末灰同量级，效果是"一整块浅色"）；与 `view.axis` 的 `major-band` 同源（P-46 的两级刻度，[ADR 0007 附录 §3](../../docs/02-adr/附录/0007-增补.md)）。**命名刻意与 `band-*`/`grid-*` 分开**：那是既有判据的计数锚 |
| **上级分段的边界与表头底** | 无描边 `rect` ×2 | `major-band-<n>-edge` / `major-band-<n>-head` | `B9C0CB`（**全高**：表头带 + 绘制区，"月的边界"）与 `E4E9F0`（**表头带内**，"这是哪个月"）——同一轴元素的**另两个投影**，与正文一起逐条同源（`template.spec.ts` 断言） |
| 下级**刻度线** | 无描边 1 px `rect` | `grid-<n>` | `E4E7EC`；**只画在表头带内的短刻度**（长度取 `EXPORT_TICK_LENGTH_PX`（**声明处**：`render-core/src/svgExport.ts`）× 适配比例，与屏幕/导出 SVG 同源；G8 人工复验第 ⑤ 条——首版是**整高**竖线，等于把刻度画进了条体区）；同源（`gridline`） |
| **日期刻度（两级）** | pptxgenjs 文本框 | `axis-<n>` | 9 pt `667085`，放在表头带内；文案同源（`label`）。**行序：上级（`level: 1`）在上、下级（`level` 缺省）在下**，基线 `MAJOR_LABEL_BASELINE_PX = 16` / `MINOR_LABEL_BASELINE_PX = 33` 与屏幕/导出 SVG **共用同值**（各写一个数字就是"所见 ≠ 所导出"）。行序由 **G8 人工复验第 ③ 条**订正（首版写反，报文"刻度上下反了"）；PPTX 侧的可判定形式是**上级文本框的 `y` 严格小于下级** |
| 图例**色块/箭头** | `rect` / `diamond` / `rect`+`triangle` | `legend-swatch-<styleKey>`（+`-head`） | 与 `exportLegendItems()` 一一对应，坐标与图例文本共用 `planTemplateA().legendRows` |
| 容器文本 | pptxgenjs `addText` | `title` / `lbl-<taskId>` / `legend-<n>` / `summary-<n>` | 名称必须全容器唯一（`buildIdMap` 会拦） |

**绘制顺序 = 注入顺序**：`背景（major-band 正文 → band → major-band-N-edge / -head → grid 短刻度）`
→ `图例图元` → `组/条/进度/菱形` → `依赖线`（OOXML 按文档序绘制，因此"背景在条形之下"是结构性质，
可由 spec 断言）。背景内部这两条顺序是**判据**而不是实现细节：

- **月份正文必须最先**（G8 人工复验第 ④ 条）：它整高、月段首尾相接 ⇒ 连续覆盖整个绘制区宽，
  画在周末带之后就会把"白周中 + 灰周末"的对比整体盖掉——首版的错正是"填充取值 + 绘制顺序"
  两个错叠在一起，`backgroundXmlOf` 因此按层拆成四段、不再一个循环画完；
- **短刻度必须最后**（第 ⑤ 条）：它只属于表头带；先画就会被灰度带与正文底盖住。

**箭头的强制口径**（人工复验第 ③ 条的根因 + 二次复验第 ② 条的订正）：

| 关系 | 形态 | 实现 |
|---|---|---|
| `FS` / `FF` | **实心三角** | 原生 `<a:tailEnd type="triangle" w="med" len="med"/>` |
| `SS` / `SF` | **开放箭头**（"→"） | 原生 `<a:tailEnd type="arrow" w="med" len="med"/>` |

> **为什么 `SS`/`SF` 不用"自绘空心三角"**（曾试过并被实测否掉）：自绘形状**没有 `stCxn/endCxn` 锚点**
> ⇒ WPS **从不重算它的位置**，拖动"入端"那条任务条时**线走而箭头留在原地**。
> G7 的招牌行为（拖动后端点跟随）优先级更高 ⇒ 用原生箭头（写在 `<a:ln>` 里，随线一起重算）。
> 代价：PPT 的 `SS`/`SF` 与 SVG/屏幕的**空心三角**不同形（维护者认可"不影响理解"）。
> **图例与画布同形**：PPT 图例里 `SS`/`SF` 画开放箭头（`legend-swatch-edge-*-head-arm1/arm2`，
> 两条细矩形旋转 ±45°）、`FS`/`FF` 画实心三角。见 [ADR 0010 附录 §2](../../docs/02-adr/附录/0010-增补.md)。
> **降级②的 `custGeom` 折线走同一套箭头规则。**

**侧栏（图例 + 摘要）的排版**：

- **图例图元以文本行的中心（`legendRows[i].y`）垂直居中**——不是"图元顶端对齐文本"；
- 图元占 `[sidebarX+6, sidebarX+24]`、文本从 `sidebarX+34` 起 ⇒ **净间距 ≥ 8 px**；
- **侧栏内容块按总高垂直居中**到侧栏框内：与甘特内容块（`fit.offsetY` 也是居中）**同基准**，
  两块的视觉中心因此一致（此前侧栏从框顶排版，视觉上浮在右上方）。

**左列标签样式与图例/摘要文案**：样式由 `render-core/exportLabels.ts` 决定
（**汇总加粗**、子行按 **WBS 深度缩进** 12 px/级封顶 3 级、超宽截断加 `…`；**缩进不计入文本**）；
文案由 `exportLegendItems()`（图例）与 `exportSummaryLines()`（摘要）**唯一生成**——
本包**不得**自己再写一遍文案（人工复验第 ④ 条即此处的教训）。

**吸附锚点与站点表**（唯一登记处仍是 [P-8](../../docs/00-baseline/裁决记录.md) 第 1 条的出/入侧表）：

```
<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="…" name="dep-l1"/>
  <p:cNvCxnSpPr><a:stCxn id="…" idx="3"/><a:endCxn id="…" idx="1"/></p:cNvCxnSpPr>
  <p:nvPr/></p:nvCxnSpPr> …
```

- 容器元素是 `p:nvCxnSpPr > p:cNvCxnSpPr`，其子元素是 **`a:stCxn` / `a:endCxn`**；
- `roundRect`/`rect`/`diamond` 的连接点序列：**0=上 1=左 2=下 3=右**
  （`idx_OOXML = COM − 1`；四站点已实测，见 [S1 结论 §二.2](../../spikes/g0-s1-pptx-connector/结论.md)）；
- **不写 `<a:cxnSpLocks/>`**（WPS 原生产物也不写）；
- `bentConnector3` 的走线由渲染引擎按两端站点与形状位置计算；**我们在幻灯片上的几何承诺是"端点落在条边上"**
  （与屏幕/SVG 同源的那两个点），不是"折线与 SVG 的折点逐点相同"。

**一级组的坐标口径**：`chOff = (0,0)`、`chExt = 子形状包围盒`、`off = 包围盒落点`、`ext = 包围盒尺寸`
⇒ 缩放恒为 1、两套坐标显式且可判（`chExt == ext` 的不变量由 `template.spec.ts` 断言）。

## 四、补丁与归一化管线

```
pptxgenjs（版面/母版/主题 + 文本）→ write({outputType:'uint8array'})
  → JSZip 解包 → 解析 name → id（含组内子形状）
  → 注入 [组 ...] + [未分组的形状 ...] + [connector ...]（按文档序分配 id ⇒ 顺序稳定）
  → 归一化：① core.xml 时间字段 → 常量；② 全部 zip 条目 date → 2000-01-01；③ 压缩/顺序固定
  → 重新打包 → 读回 p:sldSz 断言 == TEMPLATE_A_PAGE
```

**为什么"跨秒"是这条纪律的一部分**：pptxgenjs 的时间戳是**秒**精度、zip 是 DOS 时间（2 秒精度）——
两次导出若落在同一秒里会"看起来确定"，那是巧合（S7-c 首轮实测踩到）。因此确定性判据与证据
**必须跨过秒边界**（`template.spec.ts` 的 golden 与 S7-c 的 2.2 s 延迟）。

## 五、模板 A 的布局（ADR 0010 §2/§3/§7/§11）

```
页面 720 × 405 pt = 960 × 540 px（16:9）
├─ 标题带（高 34 px）：项目名 + 档位
├─ 甘特区（左列任务名 200 px + 日期刻画带 40 px + 绘制区）
└─ 侧栏 260 px：图例 + 自动摘要（任务数/依赖数/里程碑数/完成率/里程碑清单）
```

- **适配**：`fitScaleFor`（与 SVG 侧**同一公式**，来自 `render-core`）等比缩放到甘特区并居中；
- **行标签只在行高撑得下时画**（有效字号 ≥ 6 pt）：1,000 行时行高 0.4 pt，
  画标签只会生成上千个不可读文本框 —— 那时的正确动作是"提示用户折叠/换档/只导汇总"；
- **完成率**用引擎同公式（叶子按工期加权、`progress === null` 按 0 计），由 `exportSummaryOf` 给出；
- **标题不含导出时间戳**（保 golden 可复现）。

## 六、降级序列（ADR 0010 §6；按序启用）

| # | 降级 | 状态 | 依据 |
|---|---|---|---|
| ① | 不分组（全平铺 + `shapeName` 命名约定） | **预案**（未启用） | S7-a 已证跨组吸附可用 |
| ② | `custGeom` 折线（端点取自导出 SVG 的 path） | **已证可用** | S7-b（WPS 打开无修复、另存后 `custGeom` 存活） |
| ③ | 省略连线 + README 声明 | 最后手段 | 路线图 §四 |

**永不退化为位图**：三条降级路径都仍然产出原生形状（可改色、可挪位）。

## 七、验证与门禁

| 层 | 手段 | 判据 | 进 `pnpm gate`？ |
|---|---|---|---|
| ① 结构 | `template.spec.ts` 的 `structureViolations` | `p:sldSz` == 声明；形状 id 全树唯一；`stCxn/endCxn` 的 `idx ∈ 0..3` 且指向存在的形状；`grpSp` 有显式 `off/ext` 与 `chOff/chExt` 且等比；**无 `cxnSpLocks`** | **进** |
| ② 几何同源 | `template.spec.ts` | 依赖线两端吸附在 `bar-*`/`ms-*` 上、站点与 P-8 的侧向表一致（FS ⇒ 右出 3 → 左入 1；SS ⇒ 左出 1） | **进** |
| ③ golden | `template.spec.ts` | 同一文档两次导出**逐字节相等**；`docProps/core.xml` 的时间字段为常量；全部条目日期为 2000-01-01。**当前 golden**（模板 A · 演示计划 · 周档）：**16,169 字节**，sha256 `a13f17bec2dc48ca294c7f31d68dbd7308f7c0fca4073a758f9d4ac8b6426352`（P-46 收口时为 15,984 字节；差额对应上表的三层拆分——新增 `-edge` / `-head` 两段图形、刻度由整高改为短刻度） | **进** |
| ④ 负向对照 | `template.spec.ts` | 站点越界 / 引用不存在的形状 / 复用 id / 组非等比 —— **逐条必须被检出** | **进** |
| ⑤ 降级 | `template.spec.ts` | `degradeConnectors: true` ⇒ 无 `cxnSp`、有 14 处 `custGeom` 与 28 处 `lnTo`、结构仍合法 | **进** |
| ⑥ 可读性纪律 | `template.spec.ts` | 演示计划：行标签有效字号 ≥ 6 pt 且标签形状存在；1,000 行：< 6 pt 且**不生成**任何 `lbl-*` | **进** |
| ⑦ 图面要素（P-37 增补） | `template.spec.ts` | **日期刻度**文本框数与文案 == `view.axis` 的 `label`；**灰度带/短刻度**计数同源且**绘制顺序在条形之下**（`major-band-N` < `band-N` < `grid-N` < 条形 < `cxnSp`），且**刻度线只在表头带内**（`grid-*` 的高度 < 灰度带的 1/4 —— **G8 人工复验第 ⑤ 条**：首版它与灰度带一样是整高的）；**箭头**：`triangle` 数 == FS/FF、`arrow` 数 == SS/SF，且 **`tailEnd` 合计 == 依赖线条数**（不允许"没有吸附锚点的自绘箭头"）；**图例**文案逐字取自 `exportLegendItems()`+`exportSummaryLines()`（旧手写文案不得出现）、7 类图元齐全且 `SS`/`SF` 的箭头与画布同形（两条臂）；**标签**汇总加粗、子行缩进右移、与 SVG 文本**逐字相同** | **进** |
| ⑨ 侧栏排版（P-38 增补） | `template.spec.ts` | 图例图元的**垂直中心与文本行中心差 ≤ 1.5 px**；图元右缘到文本左缘 **≥ 8 px**；侧栏内容块与甘特内容块的**中心差 ≤ 20 px**（同基准居中） | **进** |
| ⑩ **两级刻度同步**（G8／P-46） | `template.spec.ts` | **上级分段带**（`major-band-N`）数 == `view.axis` 的 `major-band` 数，且它的**三个投影**（绘制区正文 / 全高边界 `-edge` / 表头底 `-head`）都在（与屏幕/导出 SVG 逐条同源）；**上级标签的 `y` 严格小于下级标签的 `y`**（**大刻度在上、小刻度在下**——"两行"这件事的可判定形式，基线取自 `render-core` 的常量；行序由 **G8 人工复验第 ③ 条**订正）；日档下上级标签数**严格少于**下级（"段内只写一次"的判别力） | **进** |
| ⑧ WPS 证据链（含返工存活） | `scripts/wps-pptx-verify.ps1`（记录制） | 打开无修复弹窗、另存后 `stCxn/endCxn` 与形状 id 集合存活、移动任务条后 connector `xfrm` 重算；**返工四类图元**在三态逐类计数一致（[addendum（依据）](evidence/template-a-demo-roundtrip-addendum.md)） | **不进**（需本机 WPS，P-9/P-17 口径） |
| ⑨ 人工复验 | 维护者按 A/B 清单走查 | 浏览器三格式导出 + WPS 真机拖动；**三轮复验全部通过**（[P-37](../../docs/00-baseline/裁决R36.md) → [P-38](../../docs/00-baseline/裁决R37.md) → [P-39](../../docs/00-baseline/裁决R38.md) **验证通过**） | **不进**（人工） |

## 八、明确不做（v0.1 内）

- **模板 B / C**、主题跟随、A4 与自定义页面（路线图 G7「可延后」）；
- **多页分页**：大文档仍是"全量缩到单页 + 导出前提示"，不做自动分页；
- **条上文字**：任务名只在左列出现（避免字号不可控）；
- **PowerPoint 下的行为承诺**：只输出标准 OOXML，未在 PowerPoint 验证 ⇒ README 写"备查、不承诺"；
- **动画/切换/备注页**：容器自带的 notesMaster 只是 pptxgenjs 的产物，不填充内容。
