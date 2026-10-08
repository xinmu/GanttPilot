/**
 * 测试侧取数工具。**住 `test/`、且不叫 `*.spec.ts`**——两条都是实测/口径逼出来的，见下。
 *
 * ## 为什么住 `packages/render-core/test/`（而不是 `src/`）
 *
 * 发布面口径：本包 `package.json` 是 `files: ["dist"]`，而构建项目
 * `packages/render-core/tsconfig.json` 的 `include` 只覆盖 `src` 之下
 * （注入 `**` 与 `*.ts` 的那条 glob 不要抄进注释：它的字符序列里含注释结束符，
 * 会把本段 JSDoc **当场截断**，`tsc` 于是把下面几行当代码解析——P3/C7-c 实测踩过）。
 * ⇒ **`test/` 下的东西天然不进产物**（与 `packages/engine/test/` 同形；engine 的文件头记着
 * "测试件住 `src/` 曾是一处含糊"，P3/C4 已把 `loopCalendar.ts` 迁到 `test/`）。
 *
 * 实测过一次"不住 `test/`"的代价：第一版把它放在 `src/fixtures.testkit.ts`，于是
 * `npx tsc -b packages/render-core/tsconfig.json` 把它编进了 `dist/`
 * （`fixtures.testkit.js` / `.js.map` / `.d.ts` / `.d.ts.map`）——测试侧助手会随包发布。
 *
 * ## 为什么不叫 `*.spec.ts`
 *
 * `checkers.spec.ts` / `textFixtures.spec.ts` 用的是"测试侧手段写成 `*.spec.ts`、可被别的
 * spec import"这个既有手法，本文件**刻意不走那条路**：实测 vitest 会**收集被 import 的
 * 那个 spec 文件自己的用例**。P3/C7-c 的第一版把 `datasetOf` 放进 `fixtures.spec.ts`，
 * `packages/render-core` 的用例数因此从 **297 涨到 387**（`fixtures.spec.ts` 的 10 例被 9 个
 * import 它的 spec 各算一遍 ⇒ +89，另加一处 +1）。一次性探针：一个只有 1 条用例的 spec，
 * 只要 `import { datasetOf } from './fixtures.spec.js'`，vitest 就报 **11 例**。
 * "测试数量一个不变"是这批的硬口径（新增类型覆盖不该顺带改变测试面），所以这里
 * **不注册任何用例**。那两个"手段文件"目前没被别的 spec import ⇒ 同一个坑暂时不显形
 * （一旦有人 import 它们，就会重演）。
 *
 * ## 为什么不并进 `fixtures.ts`
 *
 * `fixtures.ts` 是 render-core 的**生产导出**（`index.ts` 转出，演示数据与记录制测量都在用），
 * 它的公开面是"冻结-ish"的（v0.2 的处置见台账 `P-59`：`align` 一族走内部子路径、其余导出不动）；
 * 一个只为 spec 服务的取用口不该进发布面。
 */

import { DATASETS, type FixtureSpec } from '../src/fixtures.js';

/**
 * 按 `key` 取数据集（找不到即抛）。
 *
 * **为什么需要它**：把 spec 纳入 tsc 程序时实测，各 spec 此前一律写
 * `DATASETS.find((item) => item.key === KEY)` 或 `DATASETS[0]`。`noUncheckedIndexedAccess` 下
 * 前者是 `FixtureSpec | undefined`、后者是"可能 undefined"，而 `generateDocument(spec)`
 * 要的是 `FixtureSpec` ⇒ 十几处 `TS2345`。更要紧的是**语义**：静默把 `undefined` 传下去，
 * 只会把"夹具取错了"推到很远的地方（`generateDocument` 里读 `spec.seed` 才炸，甚至根本不炸）。
 * 这里把"这个 key 必须存在"变成一条会失败的断言。
 */
export function datasetOf(key: string): FixtureSpec {
  const found = DATASETS.find((item) => item.key === key);
  if (found === undefined) throw new Error(`未知数据集 key：${String(key)}`);
  return found;
}
