/**
 * S1 fixture 的**唯一声明处**：形状名/坐标/连接点/幻灯片尺寸都在这里。
 *
 * 为什么单独成文件：`fixture.ts`（生成容器）与 `verify-structure.ts`（断言）、
 * `patch.ts`（注入补丁）都必须读**同一份**几何。否则改了 fixture 而忘记改断言，
 * 校验就会假绿——这与仓库 `eslint-rules.mjs` 作为「单一定义处」的思路一致。
 *
 * 单位：EMU（1 pt = 12700 EMU）。幻灯片固定 960×540 pt = 12192000×6858000 EMU。
 */

/**
 * 幻灯片尺寸（EMU）。
 *
 * **必须是容器的真实尺寸**，而不是"我们希望它是什么"。pptxgenjs 的 `defineLayout`
 * 在本环境并未使 `p:sldSz` 变成 960×540 pt——实测容器 `p:sldSz = 9144000 × 5143500 EMU`，
 * 即 **720 × 405 pt**（16:9，Standard 4:3 之外的常规 16:9 尺寸）。
 *
 * 这个值一旦与容器不一致，边界断言就会失灵：曾经因此让 group 落到画布外被裁掉，
 * 而 L1 却全绿。因此 `run-all.mts` 会**读回产物并断言 `p:sldSz` 与本常量相等**。
 */
export const SLIDE = { cx: 9144000, cy: 5143500 } as const;

/** 1 pt = 12700 EMU。 */
export const PT = 12700;

/** 形状矩形（EMU，绝对坐标）。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
}

/**
 * `presetGeom` 的连接点索引语义。
 *
 * **这是 S1 的关键发现之一**：OOXML 的 `<a:stCxn idx>` 指的是
 * **preset geometry 的连接点序列**，与 PowerPoint COM 的 `BeginConnect(shape, idx)`
 * 枚举值**不是同一套编号**。
 *
 * 实证：脚本对 `bar-a` 调 `BeginConnect($barA, 3)`，WPS 落盘为 `idx="2"`。
 * 对 `roundRect` 而言，OOXML 连接点序列是
 * `0=上边中点 1=左边中点 2=下边中点 3=右边中点`，
 * 而 COM 的子形状连接点是 `1=上 2=左 3=下 4=右`。两者相差 1。
 *
 * 因此补丁器**必须**用本文件的 OOXML 口径，绝不可沿用 COM 的枚举值。
 */
export const ROUND_RECT_SITES = { top: 0, left: 1, bottom: 2, right: 3 } as const;

/** `roundRect` / `rect` 的连接点总数（用于 `idx` 越界断言）。 */
export const ROUND_RECT_SITE_COUNT = 4;

/** 任务条名称（同时作为 OOXML `cNvPr@name`）。 */
export const BAR_A = 'bar-a';
export const BAR_B = 'bar-b';
export const MS_1 = 'ms-1';

/**
 * 主 fixture 的几何。刻意全部留在容器真实画布 720×405 pt 内——
 * 越界形状会渲染到画布外并被裁掉（已实测踩坑：group 底边越界而无人发现）。
 */
export const SHAPES: Record<string, Rect> = {
  [BAR_A]: { x: 60 * PT, y: 70 * PT, cx: 200 * PT, cy: 36 * PT },
  [BAR_B]: { x: 420 * PT, y: 240 * PT, cx: 200 * PT, cy: 36 * PT },
  [MS_1]: { x: 620 * PT, y: 80 * PT, cx: 28 * PT, cy: 28 * PT },
};

/** 依赖连线的端点声明：`bar-a` 下边中点 → `bar-b` 上边中点。 */
export const DEP_1 = {
  name: 'dep-1',
  from: { shape: BAR_A, site: ROUND_RECT_SITES.bottom },
  to: { shape: BAR_B, site: ROUND_RECT_SITES.top },
  /** 形状与原生 WPS 产物一致（`bentConnector3`）。 */
  prst: 'bentConnector3',
  color: '00B050',
} as const;

/** group 的声明。`chOff/chExt` 由子形状包围盒推导，绝对坐标由「子坐标系 → 幻灯片」仿射映射推导。 */
export const GRP_1 = {
  name: 'grp-1',
  /**
   * 子形状**在组坐标系内**的矩形。
   *
   * 刻意用「千 EMU」量级的组坐标（而非直接复用幻灯片绝对坐标），
   * 这样 `chOff/chExt` 与 `off/ext` 是两套明显不同的数字，
   * 能真正检验坐标换算公式——若偷懒令 `chOff == off` 且 `chExt == ext`，
   * 换算即使写错也会「看起来对」，验证就失去意义。
   */
  children: [
    { name: 'grp-child-1', rect: { x: 0, y: 0, cx: 1000, cy: 200 }, color: '7030A0' },
    { name: 'grp-child-2', rect: { x: 1500, y: 0, cx: 1000, cy: 200 }, color: '00B0F0' },
  ],
} as const;

/** 1 EMU = 1/914400 英寸；1 英寸 = 96 px（PPTX 的常用换算口径）。 */
export function emuToPx(emu: number): number {
  return (emu / 914400) * 96;
}

/** EMU → pt。 */
export function emuToPt(emu: number): number {
  return emu / PT;
}

/**
 * 形状在幻灯片上的**连接点绝对坐标**。
 *
 * `roundRect` 是轴对齐矩形（无旋转/翻转），因此连接点即四边中点：
 * 上 = (cx/2, 0)、左 = (0, cy/2)、下 = (cx/2, cy)、右 = (cx, cy/2)（相对矩形原点）。
 */
export function connectionPoint(rect: Rect, site: number): { x: number; y: number } {
  switch (site) {
    case ROUND_RECT_SITES.top:
      return { x: rect.x + Math.round(rect.cx / 2), y: rect.y };
    case ROUND_RECT_SITES.left:
      return { x: rect.x, y: rect.y + Math.round(rect.cy / 2) };
    case ROUND_RECT_SITES.bottom:
      return { x: rect.x + Math.round(rect.cx / 2), y: rect.y + rect.cy };
    case ROUND_RECT_SITES.right:
      return { x: rect.x + rect.cx, y: rect.y + Math.round(rect.cy / 2) };
    default:
      throw new Error(`未知的连接点索引 ${String(site)}（roundRect 只有 0..3）`);
  }
}

/** 由两个绝对坐标点推导 connector 的 `xfrm`：包围盒 + 需要的旋转/翻转。 */
export function connectorTransform(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): { off: { x: number; y: number }; ext: { cx: number; cy: number }; rot: number; flipH: boolean; flipV: boolean } {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let extCx = Math.abs(dx);
  let extCy = Math.abs(dy);
  // 端点为矩形对齐边时，两轴都可能退化为 0（例如正好在同一列）。
  // connector 的 ext 不可为 0，否则部分渲染器忽略该形状。
  const MIN = 1;
  if (extCx === 0 && extCy === 0) {
    extCx = MIN;
    extCy = MIN;
  } else if (extCx === 0) {
    extCx = MIN;
  } else if (extCy === 0) {
    extCy = MIN;
  }
  const off = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y) };
  return {
    off,
    ext: { cx: extCx, cy: extCy },
    rot: 0,
    // 矩形框架在「右上→左下」与「左上→右下」两种对角方向上无法靠单个 ext 表达，
    // 需要翻转位。此处保留计算，即使当前 fixture 的两点均为水平/垂直关系。
    flipH: (dx < 0 && dy < 0) || (dx > 0 && dy < 0),
    flipV: (dx < 0 && dy < 0) || (dx < 0 && dy > 0),
  };
}
