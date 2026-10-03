# G4-S 环境口径

> 稳定层**不含时间戳**；本文件登记"机器与运行时"的固定字符串，任何数字都必须与本文件一起引用。

| 项 | 值 |
|---|---|
| 机器标识 | `local-dev-windows` |
| OS | Windows（本机开发机） |
| Node 版本（本机实跑） | `v26.7.0` |
| Node 版本（主口径 / CONTRIBUTING·CI） | `24.15.0` |
| 引擎来源 | `packages/engine/dist`（**构建产物**；不直接跑 `src`：引擎源码的相对 import 写的是 `.js`，Node 类型剥离解析不到） |
| 浏览器 | Chrome `见 browser-timing-*.md`，`见 browser-timing-*.md` |
| 设备像素比 | 1（`--force-device-scale-factor=1`） |
| 视口 | 1280×640 CSS px，行高 24，缓冲 5 行 |

## 复现命令

```powershell
pnpm --filter @ganttpilot/engine build        # 探针消费 dist，先构建
cd spikes/g0-s4-svg-clipping
pnpm typecheck                                # 两个 tsconfig（计算层无 DOM / 浏览器层含 DOM）
node src/run-all.mts                          # L0 几何 + L1 裁剪 + L2 定标（写 evidence/）
node src/browser-run.mts                      # L3 浏览器计时（需要本机 Chrome，记录制）
```
