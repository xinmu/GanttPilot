# 贡献指南

> 本项目当前处于 v0.1 的第一块（G0）之后，尚无产品能力；**G1 已分解为 G1.1（日历与日期算术）、
> G1.2（文档 schema、版本迁移与 WBS 层级）、G1.3（命令层与事务）**，下一步是 G1.1（可与 G1.2 并行）。
> 能力顺序与每块出口条件见 [首版能力顺序](docs/01-roadmap/首版能力顺序.md)；
> 关键决策见 [docs/02-adr](docs/02-adr/)；分解依据见 [裁决 P-10](docs/00-baseline/裁决记录.md)。

## 环境

| 项 | 要求 |
|---|---|
| Node | **24 LTS**（`engines: >=24.0.0`；仓库根的 `.nvmrc` 写的也是 24）。更新的版本（如 26）实测可用，但 CI 与发布以 24 为准 |
| 包管理器 | pnpm（`packageManager: pnpm@10.34.6`，经 corepack 或全局安装均可） |
| 系统 | Windows / macOS / Linux 均可；门禁脚本刻意避开平台特定的可执行包装 |

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
