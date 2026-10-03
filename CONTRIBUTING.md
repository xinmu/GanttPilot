# 贡献指南

> 本项目当前处于 v0.1 的 **G1.1（日历与日期算术）、G1.2（文档 schema、版本迁移与 WBS 层级）
> 与 G1.3（命令层与事务）均已完成**阶段：`packages/engine` 已落地工作日序号化日历与 O(1) 日期翻译、
> **冻结的文档模型**（规范化序列化/解析、结构化诊断校验、`v1→v2→v3` 迁移、WBS 调级），
> 以及**命令层**（唯一变更通道、before 镜像、事务与撤销/重做栈）——**G1 合集至此收口**。
> **下一步是 G2**（最小正向传播内核）：**形状与语义已在开工前冻结**——
> 排程契约见 [ADR 0004](docs/02-adr/0004-排程契约.md) 与 [裁决 P-12](docs/00-baseline/裁决记录.md)
> （G2 **不分解**；只交全量传播 + 纯结构闭包查询，**增量重算移出 v0.1**）。**尚无产品能力**。
> 能力顺序与每块出口条件见 [首版能力顺序](docs/01-roadmap/首版能力顺序.md)；
> 关键决策见 [docs/02-adr](docs/02-adr/)；分解依据见 [裁决 P-10](docs/00-baseline/裁决记录.md)；
> 文档模型规范见 [packages/engine/SCHEMA.md](packages/engine/SCHEMA.md)；
> 命令层规范见 [packages/engine/COMMAND.md](packages/engine/COMMAND.md)。

## 环境

| 项 | 要求 |
|---|---|
| Node | **24 LTS**（`engines: >=24.0.0`；仓库根的 `.nvmrc` 写的也是 24）。更新的版本（如 26）实测可用，但 CI 与发布以 24 为准 |
| 包管理器 | pnpm（`packageManager: pnpm@10.34.6`，经 corepack 或全局安装均可） |
| 系统 | Windows / macOS / Linux 均可；门禁脚本刻意避开平台特定的可执行包装 |
| Python | **3.x（G2 起必需）**：只有排程内核的**差分测试**用得到（与 `tools/cpm-reference/` 的独立参照实现比对）；门禁中**缺失即失败，不静默跳过**（[裁决 P-12](docs/00-baseline/裁决记录.md) / [ADR 0004](docs/02-adr/0004-排程契约.md) §9） |

首次准备：

```bash
pnpm install          # 同时通过 prepare 钩子设置 core.hooksPath=.husky
pnpm gate             # 跑一次完整门禁，确认环境可用
```

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm gate` | **本地合并门禁**：lint → typecheck → test → build → license:check，任一步失败即阻断 |
| `pnpm lint` | ESLint（含三包零框架/零 DOM 铁律） |
| `pnpm typecheck` | `tsc --noEmit`（包）与 `vue-tsc --noEmit`（应用） |
| `pnpm test` | Vitest（纯函数测试）；缩小范围用 `pnpm vitest run packages/engine`（从仓库根执行） |
| `pnpm build` | 三包 `tsc -b`（产出 `dist/*.js` + `*.d.ts`）+ 应用 `vite build` |
| `pnpm --filter @ganttpilot/engine build` | 只构建/类型检查某个包（`build`/`typecheck` 支持 `--filter`） |
| `pnpm license:check` | 运行时依赖许可门禁（`--prod` 口径） |
| `pnpm license:check:all` | 全域口径（含开发依赖，检查是否出现未登记许可） |
| `pnpm notices:write` | 刷新 `THIRD_PARTY_NOTICES.md`（生成物，需一并提交） |
| `pnpm dev` | 启动 `apps/web` 开发服务器 |

## 铁律（以可执行检查保证，不是口头约定）

1. **`packages/{engine,xlsx-protocol,pptx-renderer}` 零框架、零 DOM 依赖。**
   - 类型层：这三包的 `tsconfig` 不引入 `DOM` lib，也没有 `@types/node` 全局；
   - Lint 层：`eslint-rules.mjs` 的三条规则会拦下 `import 'vue'`、`window`、`document` 等；
   - 自检层：`packages/engine/src/boundary.spec.ts` 断言上述规则确实生效。
   - 想加 Vue 生态的库（虚拟滚动、拖拽）请加在 `apps/web`。
2. **类型正确性由 tsc 负责，ESLint 只做结构检查**（没有启用类型感知规则，理由见 ADR 0001）。
3. **测试先行**：引擎与协议包的每个新能力都要有纯函数测试；排程内核还要求
   不变量/性质测试 + 手工推导用例 + 独立参照实现差分测试（见裁决 R-4）。
   **G2 起**差分资产落 `tools/cpm-reference/`（`engine` 包内**不放非 TS 资产**），
   差分步骤**在 `pnpm gate` 里真实运行**；随机种子固定并随失败信息打印，方便复现
   （见 [ADR 0004](docs/02-adr/0004-排程契约.md) §9）。

## 文档模型（G1.2 之后必须遵守）

文档形状已冻结，规范说明见 [`packages/engine/SCHEMA.md`](packages/engine/SCHEMA.md)，
取舍与代价见 [ADR 0002](docs/02-adr/0002-文档模型与序列化契约.md)。改代码前请先读这两份，
其中最容易踩的四条：

1. **落盘用 ISO 日期 + 工作日工期**，工作日序号只在喂给 `Calendar` 时出现——
   文档不得被日历地平线容量绑定。
2. **`null` 表示缺失，且序列化始终显式写出全部规范字段**；因此往返一致可以直接用
   `toStrictEqual` 断言 `parseDocument(serializeDocument(doc))` 与 `doc`。
   反序列化容忍缺键但会产出 `info` 级诊断——**不要**改成静默吸收。
3. **`outlineNumber` 是派生值**，真相源是层级 + 文档序。校验只报告
   （`TREE_OUTLINE_STALE`），修复必须由调用方显式调用 `reindexDocument()`——
   **不允许在校验里顺手改写文档**。
4. **兄弟顺序 = 文档序**；调级带走整棵子树。新增任何"移动"类操作前，请先确认
   「父节点先于子节点出现在文档序」这条不变量仍然成立（`wbs.ts` 里有一条兜底断言）。

新增 schema 字段时的额外要求：同步 `SCHEMA.md` 的字段表、`canonicalizeDocument` 的规范键序、
`fixtures.spec.ts` 的夹具（否则「夹具是规范形状」用例会失败），以及本节的落地记录。

## 命令层契约（G1.3 之后必须遵守）

命令层规范见 [`packages/engine/COMMAND.md`](packages/engine/COMMAND.md)，
取舍与代价见 [ADR 0003](docs/02-adr/0003-命令层与事务契约.md)。改代码前请先读这两份，
其中最容易踩的五条：

1. **文档的变更只有一个通道**：新增任何文档写入路径都要**新增一个 `Command`**，
   不允许在应用层直接拼装文档（否则"命令产出必然合法"这条保证就有缺口）。
   新增 kind 时同步 `COMMAND_KINDS`、`COMMAND.md` 的命令表、以及"每个 kind 都被覆盖"的完备性用例。
2. **命令是纯数据、`applyCommand` 是纯函数**：不得引入时钟、随机数或全局自增
   （会破坏"同一命令序列 → 同一结果"）。id 由载荷显式给出，`suggestTaskId` 只是确定性建议。
3. **日志（before 镜像）clone-then-freeze**：冻结的是**日志自己的克隆体**，
   **绝不冻结调用方的文档**（`apps/web` 的 Vue 响应式依赖可写性）；
   应用日志时写出新鲜克隆。
4. **无操作不是失败**：恒等 patch 与 `WBS_SAME_POSITION` 返回 `{ok:true, changed:false}`，
   调用方据此**跳过撤销栈压入**；失败一律返回结构化码（不抛错），
   只有"日志与文档自相矛盾"这类程序员错误才抛 `RangeError`。
5. **结果合法性复用 `validateDocument`**：不要在命令层复制 schema 规则；
   需要 `warning` 级提示时在提交后自行调 `validateDocument`（命令层不复制诊断面）。

改动命令层时的测试要求：**双路互证**（命令产出 vs 既有领域函数 + 手工数组操作）、
**负向对照**（逆操作承重、日志条目承重、守卫有牙）、以及规模结构断言
（日志条目数与文档规模解耦）——它们都在 `journal.spec.ts` / `command.spec.ts` / `session.spec.ts` /
`documentPerformance.spec.ts` 里，改语义前先看它们为什么那样写。

## 提交约定

- 使用语义化提交信息（`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `refactor:`）；
- 推送前请确保**工作区干净**：门禁检查的是磁盘上的当前内容，而不是将被推送的那个提交；
- 门禁不通过时请修复，不要习惯性 `git push --no-verify`。确需绕过时，在提交信息中说明原因。

## 新增依赖的准入流程

1. **许可**：运行时依赖必须落在 `scripts/check-licenses.mjs` 的白名单内（MIT / ISC / Apache-2.0 /
   BSD 系 / 0BSD / CC0 / Unlicense / Python-2.0）。不在白名单时要先评估是否可接受，
   并在 PR 描述与（必要时）`docs/00-baseline/裁决记录.md` 中留痕。
2. **必要性与替代方案**：说明为什么不能自己写或用已有依赖（本项目偏好零依赖的纯函数实现）。
3. **健康度与体积**：记录最近发布、开放 issue 规模、包体（对纯前端静态部署尤其重要）。
4. **更新清单**：跑 `pnpm notices:write` 并把 `THIRD_PARTY_NOTICES.md` 一起提交。

## 文档约定

- 文档**不做版本号另存**（不使用 `-v2`、`-第二轮` 后缀），修订由 git 历史承担；
- 裁决类信息统一进 `docs/00-baseline/裁决记录.md`，按时间追加，已裁决条目不改写（推翻则追加新条目）；
- 架构决策写成 ADR 放在 `docs/02-adr/`，文件名形如 `NNNN-主题.md`。
