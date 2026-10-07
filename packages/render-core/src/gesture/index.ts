/**
 * 拖拽手势的**纯内核**（ADR 0008 §4–§8 的可执行形式）。
 *
 * ## 为什么它在 `render-core` 而不是组件里
 *
 * 手势逻辑是"指针 + 几何 → 该写什么命令"的**映射**，与 Vue 无关；而组件里的逻辑
 * **不在门禁覆盖内**（P-19 §4 的教训：`apps/web` 的 spec 收不进来）。
 * 因此这里只收**归一化指针**（`{x, y, buttons, altKey, escPressed}`，绝不碰 `PointerEvent`），
 * 由 `apps/web` 的 `useGesture.ts` 做事件归一化与 DOM 提交。
 *
 * ## 三条口径（ADR 0008 冻结，本文件只是它的实现）
 *
 * 1. **拖动期不写文档**：位置经 **会话锚点**（`compute(document, calendar, anchors)` 的入参）生效，
 *    松手才提交 `task.update` / `link.insert`（§6 的表）；
 * 2. **每帧都吸附**：候选 = `ordinalAtX(view, x, calendar)`（ADR 0007 §3 已把"出候选"归 G4、
 *    "定时机"归 G5）。`snap` 模式把候选**夹到入边约束**（拖动因此永远"顶住"边界）；
 *    `allow` 模式原样放行 —— 当候选**早于**入边约束时，`compute` 会报 `anchorConflict`
 *    （[SCHEDULE.md](../../engine/SCHEDULE.md) §四.3 情形④ + §六），UI 据此标红。
 *    **冲突判据只有这一处**：UI 不自己判"算不算冲突"（ADR 0008 §6）；
 * 3. **成环预检即拒绝**：建线前先 `wouldCreateCycle`，成环则不提交并把路径交给高亮层（§7/§8）。
 *
 * ## 一处**语义订正**（落地期实测，ADR 0008 §12 的"落地"段记录）
 *
 * 初稿把"允许 + 标红"读成"候选**晚于**约束即冲突"，于是 `allow` 模式的标红条件设成了
 * `candidate > constraint` —— **方向反了**：晚于约束根本不冲突（`compute` 取 `max(约束, 锚点)`，
 * 结果是"任务往后排、下游一起往后"，用户要的正是这个）。真正的冲突是**早于约束**
 * （`SCHEDULE.md` §四.3 情形④ 的原文："锚定早于入边约束 → `anchorConflict`"）。
 * 于是两种模式的分工是：
 *
 * | 模式 | 候选 | 引擎行为 | 冲突 |
 * |---|---|---|---|
 * | `snap` | 夹到 `[0, 约束]` | `ES = 约束`/候选（**永不触发** `anchorConflict`） | 无 |
 * | `allow` | 原样（可能 < 0 或 < 约束） | `ES = max(约束, 锚点)` = 约束（任务顶在边界上） | **有**（`anchorConflict`） |
 *
 * 两种模式下"任务最终落在哪"是同一个答案（引擎说了算），差别在**用户是否被告知"你拖过头了"**——
 * 这正是 IX-05 要的那个切换：默认帮用户夹住，或如实放行并标红。
 *
 * ## 第三处订正：候选序号是**抓取点相对**的，且按模式分别定义（裁决 P-22，ADR 0008 §13）
 *
 * P-21 的人工复核把"按下即跳位 / 右侧空白点击工期翻倍"归给 R1（指针坐标参照物取错）。
 * 落地批次 A 时发现**归因不完整**：`pointerStartX` 存了却从未被使用，而候选一直是
 * `ordinalAtX(pointer.x)` 的**绝对**语义——于是修好 R1 之后，"条体左端跳到鼠标位置"仍然成立；
 * 而 `resize-duration` 的 patch 写作 `候选 − 原开始 + 工期`，在右端**按下不移动**就会把工期
 * 翻成约 `2D − 1`。这正是复核第 7 项"向右拉条体跟手、**松手回原位**但日期仍变"的字面成因。
 *
 * 现在的口径（三条一起读）：
 *
 * | 模式 | 候选的语义 | 松手 patch |
 * |---|---|---|
 * | `move` | 新**开始**序号 = `originOrdinal + delta` | `{startDate, endDate}`（工期不变） |
 * | `resize-start` | 新**开始**序号 = `originOrdinal + delta` | `{startDate, durationDays}`（**不含** `endDate` ⇒ 完成日不变） |
 * | `resize-duration` | 新**完成**序号 = `originOrdinal + max(1, D) − 1 + delta` | `{durationDays, endDate}`（**不含** `startDate`） |
 *
 * `delta` 一律是"当前指针的序号 − **抓取点**的序号"（{@link deltaFor}），因此**按下不动 = 零位移**：
 * 手势不产出任何命令，文档一字不改（这是"按下即重绘"的负向对照）。
 * `resize-duration` 拖动期条体**本体不动**（会话锚点只有 `startOrdinal`，ADR 0004 §2 的形状不扩），
 * 用户看到的是 {@link dragPreviewFor} 给出的**预览轮廓**——预览与松手提交共用
 * {@link resolveDragOutcome}，所以"看到的"与"松手得到的"不可能分叉。
 *
 * ## 第四处：拖动期的**下游**也所见即所提交（裁决 P-45）
 *
 * 锚点只承载**位置**，所以 `resize-duration` 拖动期 `compute` 用的仍是文档里的**旧工期**：
 * 条体本体（§14）与轮廓都对，但**下游要等松手才一次到位**。工期是**文档字段**（不是锚点字段），
 * 因此唯一的零契约变更修法是"喂 `compute` 一份改了这一个字段的**未提交副本**"
 * （{@link previewDocumentFor}，`patch` 取自 {@link GestureUpdate.dragOutcome}）。
 * **契约面一字未改**：`SessionAnchor` 仍是 `{taskId, startOrdinal}`，副本不进命令通道、不进撤销栈、不落盘。
 *
 * ## 模块表（P3/C5-b 的拆分）
 *
 * 本文件此前是单文件 `gesture.ts`（1,358 行 / 11 项职责）。拆分**不改任何语义与公共面**：
 * `packages/render-core/src/index.ts` 的"拖拽手势内核"段一个符号没动，只是它们现在住在同目录的模块里。
 *
 * | 模块 | 职责 | 关键符号 |
 * |---|---|---|
 * | `pointer.ts` | 屏幕坐标 → 内容坐标、条体命中、命中反算、位移与候选序号 | `pointerFromClient` / `barHitFor` / `resolvePointerTarget` / `deltaFor` / `candidateOrdinalFor` / `ordinalAtClamped` |
 * | `candidates.ts` | 入边约束与吸附（`snap` 的夹取、`allow` 的放行） | `entryConstraintFor` / `snapCandidate`（`dragCandidate` 包内） |
 * | `outcome.ts` | 结果解析、预览几何、未提交文档副本 | `resolveDragOutcome` / `dragPreviewFor` / `drawnBarForRow` / `previewDocumentFor` |
 * | `linking.ts` | 建线：四项判定、重复边预检、产出 | `LinkPreview`（`updateForLink` / `buildCandidateLink` 包内） |
 * | `state.ts` | 状态类型、状态机、产出构造 | `GestureState` / `beginGesture` / `reduceGesture` / `idleGesture` |
 *
 * **"区域 → 模式"只有一行**（{@link dragModeFor}）：公式在 `../zones.ts`（**唯一实现处**），
 * 本目录只**消费**它——"看起来能抓的那一点"与"真的按判定区分类的那一点"因此必然是同一个数。
 * **依赖方向单向**：`pointer → candidates → state`、`outcome → state`、`linking → state`
 * （`state` 反向只 import 类型），因此 `interaction.ts` 那条"不得成环"的约束仍成立
 * （`interaction → gesture`，反向零依赖）。
 */

// ---------------------------------------------------------------- 再导出（公共面 = 拆分前逐符号相同）

// ---- pointer.ts（坐标与命中）
export {
  barHitFor,
  candidateOrdinalFor,
  dayDeltaFor,
  deltaFor,
  ordinalAtClamped,
  pointerFromClient,
  resolvePointerTarget,
  type ClientPointerArgs,
  type HitTarget,
  type PointerInput,
  type ResolvePointerArgs,
} from './pointer.js';

// ---- candidates.ts（入边约束与吸附）
export { entryConstraintFor, snapCandidate } from './candidates.js';

// ---- outcome.ts（结果解析、预览几何、未提交副本）
export {
  dragPreviewFor,
  drawnBarForRow,
  previewDocumentFor,
  resolveDragOutcome,
  type DragOutcome,
  type DragPreview,
  type DrawnBar,
} from './outcome.js';

// ---- linking.ts（建线）
export { type LinkPreview } from './linking.js';

// ---- state.ts（状态机与产出构造）
export {
  beginGesture,
  dragModeFor,
  idleGesture,
  reduceGesture,
  type AnchorEntry,
  type AnchorMode,
  type BeginGestureArgs,
  type GestureState,
  type GestureUpdate,
  type ReduceGestureArgs,
} from './state.js';

// ---- 由更下层拥有、但本内核的公共面一直带着的两个类型（`DragMode` 的声明处是判定区公式所在的模块）
export type { DragMode } from '../zones.js';

export type { ZoomKey } from '../manifest.js';
