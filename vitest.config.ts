import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['packages/*/src/**/*.spec.ts', 'packages/*/lint-boundary/**/*.spec.ts', 'scripts/**/*.spec.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    environment: 'node',
    reporters: ['default'],
    passWithNoTests: false,
    /**
     * **并行度上限**（[P-38](../../docs/00-baseline/裁决R37.md) 的"候选①：配置层隔离"落地）。
     *
     * ## 为什么需要它
     *
     * `packages/engine/src/schedule.performance.spec.ts` 有两条**判据**：
     * `medianP50 ≤ 1 ms`（管**实现退化**：朴素实现慢 2.4–3.0× ⇒ 必被拦下）与
     * `medianP99 ≤ 2 ms`（管**并行争用抖动**；P-38 实测安静态上界 **1.40 ms**）。
     * 但"抖动"这件事**不是测试能控制的**：当整套 55 个 spec 一起抢核时，
     * 该 spec 的 p99 会被推到 2–3 ms 量级 ⇒ **判据红，而实现没有任何退化**
     * （本轮实测并登记：**同一份代码**单独跑 p50 = **334 µs** / p99 = **468 µs**；
     * 满负载下 medianP99 触到 **3.07 ms**；**把 `schedule.ts` 换回改动前的版本、
     * 满套件重跑仍然红**（p99 = 973 µs、最差 4.40 ms）——即"红"与本次改动无关）。
     *
     * ## 为什么是"限并行度"而不是"放宽阈值"
     *
     * P-38 明写：**不放宽 `1 ms` 数值**，动作是"给该 spec 独占并行槽 / 上配置层隔离"。
     * 限制 worker 数是最小、最可解释的一种隔离：它不改任何数值判据、不改收集范围、
     * 不新增依赖、也不把任何 spec 逐出 `pnpm gate`（`test` 步仍跑全部 55 个 spec）。
     *
     * ## 代价（明确接受）
     *
     * 整套测试的墙钟变长（并行度换稳定性的常规取舍：本机实测 **6.8 s → 14.1 s**，
     * 而该 spec 的读数从"满负载下的 2–3 ms 抖动"回到 **p50 337 µs / p99 476 µs**）。
     * 这条"用时间换判据可信"的取舍与仓库既有风格一致——P-12 的
     * "**缺失即失败，不静默跳过**"就是同一种取向：宁可慢，也不要一条会自己红的判据。
     */
    maxWorkers: 2,
    // `minWorkers` 曾经写在这里，但 **Vitest 5 的 `InlineConfig` 里没有这个键**（P3/C7-e 把
    // 本文件纳入 tsc 程序时当场抓到：`Object literal may only specify known properties`）——
    // 也就是说它从写下那天起就**什么也没做**，"限并行度"实际只由上面的 `maxWorkers: 2` 生效
    // （与实测 6.8 s → 14.1 s 的读数一致）。刻意删掉而不是留着：一个不存在的键会让人
    // 以为还有第二道限制。要"保活 worker"请用 `isolate: false` 一类的真实开关。
  },
});
