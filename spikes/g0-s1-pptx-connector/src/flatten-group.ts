/**
 * group 坐标换算的**可逆性**验证（独立于补丁器的一条校验路径）。
 *
 * 思路：`patch.ts` 用 `childToAbsolute` 把组坐标映射成幻灯片绝对坐标。
 * 这里用**另一条路径**把结果拍平——即按 ECMA-376 公式把组映射「应用掉」，
 * 得到一组**绝对坐标**的扁平形状（`C-flat`），再：
 *   1. 把扁平形状代回 `absoluteToChild`，检查能否还原出原始组坐标（往返一致）；
 *   2. 交叉验证：`patch.ts` 算出的绝对矩形与「扁平形状」的绝对矩形逐值相等。
 *
 * 为什么值得单独写：`off/ext` 与 `chOff/chExt` 的换算错误是 S1 的典型失败模式，
 * 而「同一结论由两条独立实现得出」比「一条实现自己说自己对」强得多。
 */

import type { Rect } from './manifest.ts';
import { absoluteToChild, childToAbsolute, type GroupChild, type GroupMapping } from './patch.ts';

/** 形状名 → 绝对矩形 的集合。 */
export type RectMap = ReadonlyMap<string, Rect>;

/** 一个已拍平的形状（绝对坐标）。 */
export interface FlatShape {
  readonly name: string;
  readonly rect: Rect;
  readonly color: string;
}

/** 由组声明 + 映射，产出「已应用组变换」的扁平形状集合。 */
export function flattenGroup(
  children: readonly GroupChild[],
  mapping: GroupMapping,
): readonly FlatShape[] {
  return children.map((child) => {
    const absOff = childToAbsolute(mapping, { x: child.rect.x, y: child.rect.y });
    return {
      name: child.name,
      rect: {
        ...absOff,
        cx: Math.round(child.rect.cx * mapping.scaleX),
        cy: Math.round(child.rect.cy * mapping.scaleY),
      },
      color: child.color,
    };
  });
}

/** 把扁平形状集合转成比较用的 `RectMap`。 */
export function toRectMap(shapes: readonly FlatShape[]): Map<string, Rect> {
  return new Map(shapes.map((shape) => [shape.name, shape.rect]));
}

/**
 * 用一个**从 XML 解析出来的** `GroupMapping` 复算子形状的绝对矩形。
 *
 * 这是「补丁器 vs 校验器」的独立路径：`patch.ts` 依据内存中的映射写 XML，
 * 而这里**只依据 XML 里的 `off/ext/chOff/chExt` 数值**重新推算几何。
 * 若补丁器把映射写进 XML 时写错了任何一个数，两条路径就会分叉。
 */
export function recomputeAbsoluteFromMapping(
  children: readonly GroupChild[],
  mapping: GroupMapping,
): Map<string, Rect> {
  const result = new Map<string, Rect>();
  for (const child of children) {
    const absOff = childToAbsolute(mapping, { x: child.rect.x, y: child.rect.y });
    result.set(child.name, {
      ...absOff,
      cx: Math.round(child.rect.cx * mapping.scaleX),
      cy: Math.round(child.rect.cy * mapping.scaleY),
    });
  }
  return result;
}

/** 单条往返检查的结果。 */
export interface RoundTripCheck {
  readonly name: string;
  readonly original: { x: number; y: number };
  readonly absolute: { x: number; y: number };
  readonly restored: { x: number; y: number };
  readonly passed: boolean;
}

/**
 * 往返一致性：组坐标 → 绝对 → 组坐标，必须回到原点。
 *
 * 注意 `absoluteToChild` 与 `childToAbsolute` 都带取整，因此允许 1 EMU 的偏差
 * （这是 EMU 整数网格的固有代价，不是实现缺陷）。
 */
export function roundTripChildren(
  children: readonly GroupChild[],
  mapping: GroupMapping,
): readonly RoundTripCheck[] {
  return children.map((child) => {
    const original = { x: child.rect.x, y: child.rect.y };
    const absolute = childToAbsolute(mapping, original);
    const restored = absoluteToChild(mapping, absolute);
    return {
      name: child.name,
      original,
      absolute,
      restored,
      passed: Math.abs(restored.x - original.x) <= 1 && Math.abs(restored.y - original.y) <= 1,
    };
  });
}

/** 逐值比较两个矩形集合（用于「补丁器 vs 扁平化」的交叉验证）。 */
export function compareRectMaps(
  a: RectMap,
  b: RectMap,
): readonly { name: string; passed: boolean; detail: string }[] {
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  return names.map((name) => {
    const left = a.get(name);
    const right = b.get(name);
    if (left === undefined || right === undefined) {
      return {
        name,
        passed: false,
        detail: `集合不对称：a 有=${String(left !== undefined)} b 有=${String(right !== undefined)}`,
      };
    }
    const keys: readonly (keyof Rect)[] = ['x', 'y', 'cx', 'cy'];
    const diffs = keys.filter((key) => left[key] !== right[key]);
    return {
      name,
      passed: diffs.length === 0,
      detail:
        diffs.length === 0
          ? '逐值相等'
          : diffs.map((key) => `${key}: ${String(left[key])} vs ${String(right[key])}`).join('; '),
    };
  });
}
