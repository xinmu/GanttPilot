/// <reference types="vite/client" />

/**
 * 应用侧对 `window` 的扩展（测量钩子，见 `src/measure/index.ts`）。
 *
 * 这两个字段只在 `?measure=` 出现时才被写入：`__GANTTPILOT_MEASURE__` 是 CDP 侧的入口，
 * `__GANTTPILOT_READY__` 是"钩子已装好"的信号（避免竞态）。
 */
interface Window {
  __GANTTPILOT_MEASURE__?: unknown;
  __GANTTPILOT_READY__?: boolean;
  __GANTTPILOT_ERROR__?: string;
}
