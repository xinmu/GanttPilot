import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * G0 阶段的应用骨架配置。
 *
 * `base: './'` 是为了 G8 的 GitHub Pages 静态部署（子路径部署时资源引用必须是相对路径）。
 * 增量构建与依赖预打包等优化在 G4 引入真实渲染负载后再按实测调整。
 */
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
