# S3 · 环境口径（固定字符串，重跑逐字节一致）

| 项 | 值 |
|---|---|
| 平台 | Windows x64 |
| CPU | 13th Gen Intel Core i7-13700K |
| 内存 | 32 GB |
| 时区 | UTC+08:00（系统默认） |
| 主口径运行时 | Node **24.15.0**（与 CONTRIBUTING / CI 口径一致） |
| 记录口径运行时 | Node **26.7.0** |
| 参照实现运行时 | Python 3.14.5（仅差分测试使用，不是发行依赖） |
| 测量前提 | 测量期间机器空闲；判定值取 median-of-suites，同时记录最差 suite |

> 刻意写固定字符串而不写 `process.version`：本文件用于固定环境口径，不是版本探测器。
> 性能报告按运行时大版本分别落盘（`perf-node24.md` / `perf-node26.md`）。

## 未覆盖（必须与性能结论一起读）

1. **浏览器与绘制侧未测量**：没有 `requestAnimationFrame`、样式/布局/GC 停顿的界面表现数据，
   因此"拖拽 ≥30fps"（G5 门禁）**未被本 spike 验证**，Node 数字不能替代它；
2. 未测 Worker 化、增量拓扑序维护的工程实现、约束类型（G-3/G-4）、2,000 任务的正式压测（v0.5）；
3. 未做 Microsoft PowerPoint/Excel 类第三方工具验证（本 spike 与 WPS 无关）。
