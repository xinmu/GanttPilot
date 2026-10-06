import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * **离线单文件分发的构建配置**（P-49 §2；G8）。
 *
 * ## 与 `vite.config.ts`（在线产物）的三处不同
 *
 * | 项 | 在线产物 | 本配置 | 为什么 |
 * |---|---|---|---|
 * | 产物目录 | `dist/` | **`dist-offline/`** | 两套产物服务两个场景（在线 Demo / 双击即用），**不互相污染** |
 * | 代码分块 | 默认（`exceljs`/`pptxgenjs` 各自成 lazy chunk） | **`inlineDynamicImports`** ⇒ 全部合进一个 chunk | `file://` 下浏览器按 **CORS 拒绝**加载 module script 与其外链 chunk；两个**动态 `import()`**（导入/模板用 `exceljs`、导出用 `pptxgenjs`）在 `file://` 下会失败 ⇒ 必须内联 |
 * | CSS | 独立文件 | `cssCodeSplit: false` ⇒ 单文件 CSS | 内联进 HTML 时少一跳（脚本侧只做一次字符串替换） |
 *
 * ## 代价（如实接受，P-49 §2 已定）
 *
 * 体积从约 190 KB（gzip 67 KB）涨到约 1.4 MB —— **单文件分发的场景里体积不敏感**，
 * 而"双击即用、不需要 Node/Python/任何托管"是这个产物的全部意义。
 * **在线产物的口径不变**：`smoke:build` 仍断言首屏主 chunk 不含这两个库。
 *
 * ## 与"几何同源"无关
 *
 * 本文件只改**打包形状**，不改任何几何/契约：三个计算包仍是零 DOM 的实现，
 * 应用层仍是 DOM 的唯一落点。
 */
export default defineConfig({
  plugins: [vue()],
  // `file://` 下绝对路径（`/assets/...`）会解析到盘根 ⇒ 全部 404。
  base: './',
  build: {
    outDir: 'dist-offline',
    emptyOutDir: true,
    // 单文件产物不需要 sourcemap（它会让体积再翻一倍，且没人会去调试那份文件）。
    sourcemap: false,
    cssCodeSplit: false,
    // 资源原地内联（本项目没有图片/字体，这一行是防御性的）。
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    /**
     * **关掉代码分块**（Vite 8 起用 `rolldownOptions.codeSplitting`；旧的
     * `rollupOptions.output.inlineDynamicImports` 已 deprecated，实测会告警）：
     * 全部模块（含两个**动态 `import()`** 的 `exceljs` / `pptxgenjs`）合进一个 chunk。
     */
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
