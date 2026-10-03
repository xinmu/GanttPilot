import { createApp } from 'vue';

import App from './App.vue';

/**
 * 应用入口。
 *
 * 这里挂一个**应用级错误捕获**：出错时把消息与组件栈写到 `window.__GANTTPILOT_ERROR__`，
 * 让 `scripts/measure-render.mjs`（零依赖 CDP 驱动）能把"页面里到底哪一行炸了"读出来——
 * 打包产物里的栈是压缩过的，没有这个抓手排查成本极高。
 */
const app = createApp(App);

app.config.errorHandler = (error, instance, info) => {
  const name =
    (instance as { $?: { type?: { __name?: string; name?: string } } } | null)?.$?.type?.__name ??
    (instance as { $?: { type?: { __name?: string; name?: string } } } | null)?.$?.type?.name ??
    '未知组件';
  const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  (window as unknown as { __GANTTPILOT_ERROR__?: string }).__GANTTPILOT_ERROR__ =
    `[组件] ${name}\n[信息] ${info}\n${message}`;
  console.error('[GanttPilot] 未捕获错误：', error, info);
};

app.mount('#app');
