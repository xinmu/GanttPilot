# PPTX 渲染规范（G7）

> 本文件是 `@ganttpilot/pptx-renderer` 的**权威规范**（与 [`engine/SCHEDULE.md`](../engine/SCHEDULE.md)、
> [`render-core/SPEC.md`](../render-core/SPEC.md)、[`xlsx-protocol/PROTOCOL.md`](../xlsx-protocol/PROTOCOL.md) 同构）。
> 契约出处：[ADR 0010 导出契约](../../docs/02-adr/0010-导出契约.md)（**冻结面**）；
> 准入实验：[S-G7 四条门禁](evidence/g7-s7-a-b-wps.md)（跨组吸附 / `custGeom` / 字节确定性 / 适配数值）；
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
| 依赖线 | `<p:cxnSp>` + `bentConnector3` | `dep-<linkId>` | 双端吸附见下 |
| 一级组 | `<p:grpSp>` | `grp-<summaryId>` | 汇总行 + 其**直接**子行形状 |
| 容器文本 | pptxgenjs `addText` | `title` / `lbl-<taskId>` / `legend-N` / `summary-N` | 名称必须全容器唯一（`buildIdMap` 会拦） |

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
├─ 甘特区（左列任务名 200 px + 日期刻画带 28 px + 绘制区）
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
| ③ golden | `template.spec.ts` | 同一文档两次导出**逐字节相等**；`docProps/core.xml` 的时间字段为常量；全部条目日期为 2000-01-01 | **进** |
| ④ 负向对照 | `template.spec.ts` | 站点越界 / 引用不存在的形状 / 复用 id / 组非等比 —— **逐条必须被检出** | **进** |
| ⑤ 降级 | `template.spec.ts` | `degradeConnectors: true` ⇒ 无 `cxnSp`、有 14 处 `custGeom` 与 28 处 `lnTo`、结构仍合法 | **进** |
| ⑥ 可读性纪律 | `template.spec.ts` | 演示计划：行标签有效字号 ≥ 6 pt 且标签形状存在；1,000 行：< 6 pt 且**不生成**任何 `lbl-*` | **进** |
| ⑦ WPS 证据链 | `scripts/wps-pptx-verify.ps1`（记录制） | 打开无修复弹窗、另存后 `stCxn/endCxn` 与形状 id 集合存活、移动任务条后 connector `xfrm` 重算 | **不进**（需本机 WPS，P-9/P-17 口径） |
| ⑧ 人工复验 | 维护者在 WPS 真机拖动任务条 | 端点跟随（G7 出口条件③的签署项） | **不进**（人工） |

## 八、明确不做（v0.1 内）

- **模板 B / C**、主题跟随、A4 与自定义页面（路线图 G7「可延后」）；
- **多页分页**：大文档仍是"全量缩到单页 + 导出前提示"，不做自动分页；
- **条上文字**：任务名只在左列出现（避免字号不可控）；
- **PowerPoint 下的行为承诺**：只输出标准 OOXML，未在 PowerPoint 验证 ⇒ README 写"备查、不承诺"；
- **动画/切换/备注页**：容器自带的 notesMaster 只是 pptxgenjs 的产物，不填充内容。
