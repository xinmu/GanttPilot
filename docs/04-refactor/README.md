# v0.2 重构计划（入口）

> **这份计划是「施工图」，不是「规范」。** 它规定**先做什么、做完怎么算完、什么本轮不做**；
> 契约本身仍在 [ADR](../02-adr/) 与各包规范，裁决登记仍在 [裁决记录](../00-baseline/裁决记录.md)。
> **它是临时物**：v0.2 合流后按 [登记与本轮不做](05-登记与本轮不做.md) §收口 处理（有价值的部分迁进台账与记录层，其余删除）。
> 立此计划的事实基线与既定决策（原七项 + P1 收口后追加的决策 8）见 [基线与决策](01-基线与决策.md)。

## 一、怎么用（按需注入）

**不要整读本目录**——每份都是自足的，按你当下要做的事只读一份：

| 你现在要做什么 | 只读这一份 | 体量 |
|---|---|---|
| 改文档（分层、精简、去记录化、补登记） | [文档重构](02-文档重构.md) | 中 |
| 改代码（去重、删死码、拆文件、常量单点化） | [代码重构](03-代码重构.md) | 大 |
| 判断「这一步算不算做完」 | [验收与门禁](04-验收与门禁.md) | 中 |
| 想知道某个处置**为什么**这么定 | [基线与决策](01-基线与决策.md) | 中 |
| 想起「是不是有件事说了不做」 | [登记与本轮不做](05-登记与本轮不做.md) | 小 |
| **开新会话 / 交接上下文** | **本文件 + [基线与决策](01-基线与决策.md)** | 小 + 中 |

**最小交接包**：本文件 + [基线与决策](01-基线与决策.md)。其余四份按需取。

## 二、阶段总览

| 阶段 | 主题 | 主要产出 | 状态 |
|---|---|---|---|
| **P0** | 盘点与裁决 | 四路盘点（文档 / 代码 / 脚本与卫生 / 交叉验证）+ 七项决策 | ✅ 完成（2026-10-07） |
| **P1** | 建可执行检查（**先于改内容**） | 三条新门禁 + 它们在现状上**必须翻红**的负向对照 | ✅ 完成（2026-10-07，四批：`8086fa7` P1-a / `19ed355` P1-b / `17067b7` P1-c / `9254ffb` P1-d） |
| **P2** | 文档重构 | 分层落地、ADR 去记录化、台账精简、补 R48–R50 登记 | ✅ **完成**（D1–D10；**文档侧全绿**，常量侧 31 处交割 P3/C5） |
| **P3** | 代码重构 | 逐包去重 / 删死码 / 拆大文件 / 常量单点化 | ✅ **完成**（**C1–C5**；**C6（a–g 七批）**；**C7（a–j 十批）**：依赖方向 · spec 进 tsc（四包，`N12` 关） · 工具链类型检查 · 收尾闸自检进门禁 · `tmp/` 回收与 `.gitignore` · 三项改名与 PPTX golden 重锚 · 生成物新鲜度守卫（`N10`） · Python 口径；**C8（a–d 四批）证据卫生**：原始读数所有权（`evidenceRawCheck` + §8g 守卫） · spike 视觉证据（"重复 PNG"实为承重证据） · 记录制证据的本机路径（例外逐条登记，警告 1 → 0） · 生成物自指（`docs:index` 迭代到不动点）；三处计划订正见 [批次记录-P3-C8](08-批次记录-P3-C8.md)） |
| **P4** | 交叉印证与验证 | 文档↔代码双向核对 + 记录制证据**集中重取一次** | 🔄 **进行中**：**P4-a / P4-f 已完成**（`check-api-surface.mjs` 进 `docs:check`；精简层结构复核 −2.4 KB），b–e 未开工（批次表见 [验收与门禁](04-验收与门禁.md) §六） |
| **P5** | 稳定与合并 | 九步门禁全绿（含一次干净检出 CI 运行）+ review + `v0.2` tag | ⬜ 未开始 |

> **P1 完成意味着什么**：三条检查已经落地并**在现状上翻红**（常量重述 80 处、分层/入口 32 条、跨层 17 条），
> 所以 `pnpm docs:check` 自 `9254ffb` 起是**红的**——这是 04 §一设计的红窗，**不是事故**：
> 它是 P2 的 D 批与 P3 的 C5 的输入清单，修完之后才转绿。既有结构检查（链接 / 锚点 / 台账 / 存档覆盖 /
> 体量 / 策略 / 白名单）与 `pnpm test` 的 55 spec / 809 例仍是全绿。
>
> **D1 又加了两项守卫**（本机绝对路径 / 被 gitignore 覆盖的临时路径，见 [文档重构](02-文档重构.md) §三 的 D1 记录）：
> 现状再加 **3 处 error**——`需求基线.md:3`、`评估报告.md:5`、`首版能力顺序.md:9` 的 `D:\Downloads\…`
> 正是决策 8 的三处指认，也就是 **D2 的执行清单**；另有 **2 条新警告**（归档/证据层的本机路径存量 → C8/D9，
> `CONTRIBUTING.md` 的 `tmp/` 引用缺声明词 → D7），警告不阻断门禁。
>
> **D2 已把那 3 处转绿**（原文入仓 + 三处改链带 `原文口径`），总错误回到 **49**（＝P1-d 的基线）；
> 同时落了**溯源守卫** `sourceLineCheck`（入库原文的来源块 + 正文 `sha256` 可复算；`--selftest` **24 例**），
> 并实测出一条前置：**证据层（`evidence/`）在索引里 0 条登记**，登记它会让 ≈25 处 L1 链接需要标记词 ⇒ 归 C8，见 02 §三 的 D2 记录。
>
> **D3 补登记了 4 轮**（`P-50`/R48、`P-51`/R49、`P-52`/R50 三轮 G8 人工复验 + `P-53`/R51 门禁改序，
> 收敛了 `0001-增补` 的"裁决登记待补"），并把台账 §三 由 81 行逐轮叙事压到 **24 行**（未决 0 条 + 已闭摘要 + 指针）：
> 轮次上界推进到 **R51**、覆盖无缺口，**总错误仍 49**、**警告 5 → 4**（"R50 超出台账上界"按预期消失），
> 必读层 74.3 → **69.5 KB**。
>
> **D4 把路线图拆开了**：先把 **G0–G8 的逐块判定**回写进 §二 与三个块小节（G8 的"剩一次人工复验"改为已完成，
> `P-52`），再把 G6–G8 的块正文**逐字**迁入新建的 [归档-G6–G8](../01-roadmap/首版-记录-归档-G6-G8.md)（G2/G3/G4 的块级口径按块迁入既有两个归档）：
> 路线图 **34.41 → 11.96 KB**（目标 ≤12 KB ✓）、**必读层 69.5 → 47.1 KB**、精简层 582 → **560 KB**；
> 结构类错误 0、**总错误仍 49**、4 处外部锚点全部仍可解析。顺带补掉常量守卫的盲点（"已重定为 …"这类改口径写法）——
> **常量重述 81 → 77 处**（错值 27 → 25），**L1 的判定文档至此零常量重述**。
>
> **D5（ADR 去记录化）拆成三个子批、已全部落地**：`0007` 把 §16.2/§16.4 的实测与教训迁入附录 §10；
> `0008` 把 §16.7 的 **129 行**六轮返工史**逐字**迁入附录 §4，正文只留 **27 行最终生效口径**；
> 其余 8 份 ADR 核对为**已无记录性正文**（"落地记录"都已在各自附录）。两处搬运都做了**逐行/逐字节比对**
> 以证明逐字性（各只有一处去重/校订）。同批补齐 ADR 与路线图的**跨层标记词**
> ⇒ **违例文档 17 → 11 份、总错误 49 → 42**；`0008` 体量 57.60 → **47.99 KB**，
> 路线图 12.13 → **11.975 KB**（守住 ≤12 KB）。
>
> **D6 把契约常量收到一处**：文档侧的字面量改成**指回声明处**（`render-core/SPEC.md` 25 → 0、ADR 0007/0008 9 → 0），
> 常量重述 **77 → 36 处**；并**实测修正了"1:1 镜像"这个前提**——三对里 `0004↔SCHEDULE`、`0009↔PERSISTENCE`
> 的逐字重复是 **0**，真双写只在 `0006↔PROTOCOL`（12 段，已收口到 0）。
>
> **D7 瘦了两份根文档**：`README` **47.92 → 29.46 KB**（两个「已知限制」合并成一份）、
> `CONTRIBUTING` **49.70 → 14.91 KB**（−70%：九个契约节 → 一张「契约 | 权威住所 | 最容易踩的 2–3 条」表），
> 并订正三处过时说法（**门禁顺序**、**远端已接入**、**`file://` 的窄口径**）。
> 精简层 **560 → 497.9 KB**、总错误 **42 → 40**、警告 **4 → 3**；跨层涉及文档 **10 → 8 份**。
>
> **D7.5 把必读层预算的口径收口了（采 A）**：「轮次导读」移出为**生成物**（`pnpm docs:index` 由存档标题 + 台账轮次列推导）、
> 待定清单的**已闭结转行**（22 行）移入记录层 ⇒ 台账 **24.1 → 19.2 KB**、清单 **11.06 → 1.16 KB**；
> 新立 [裁决R52](../00-baseline/裁决R52.md)（台账行 `P-54`）把「必读」定义为**台账登记本体 + 当前规划 + 待定清单**，
> 并按**实测下限 32.0 KB** 把 `mustReadKb` **25 → 34**：**必读 47.2 → 32.4/34 KB 转绿**，总错误 **40 → 34**。
> ⚠️ **同源的 `slimKb: 100` 仍够不到**（实测 488.7 KB，其中契约类 ≈387 KB——决策 3 要求它们留在精简层）：
> 已按同一条 A 处理（D7.6）：生成物标 `generated`（剔除 13.7 KB 重复计数）+ 立 [R53/P-55](../00-baseline/裁决R53.md) 把 `slimKb` 100 → **500**
> ⇒ **精简层 475.7/500 KB 转绿**。
>
> **D8 把入口与证据层收口了**：`docs/README.md` 改造为 **L0 注入入口**（新增「注入协议」节、9 行问题表的**目标全部换成 slim**、
> 说明"归档物为何不在入口出现"）⇒ **`[入口]` error 14 → 0**、"15 份未登记文档"警告消失；
> **20 份证据**（`apps/web/evidence` 15 + `packages/pptx-renderer/evidence` 5）登记为 `record`/`archive`（索引 **87 → 107 份**），
> L1→证据的 14 处链接补齐标记词（顺带净减 2 处）⇒ **总错误 20 → 6**（余 6 条全是存量跨层）。
>
> **D9 处置了 spike（先把工具底座搬出来、再按两级裁）**：`scripts/wps-pptx-verify.ps1` 对探针
> `wps-common.ps1` 的 dot-source **先解耦**（逐字迁入 `scripts/wps-com.ps1`，10 个函数、纯函数输出实测一致）；
> 三个 spike 目录共 106 个入库文件 / 757.4 KB，按新立的 [R54/P-56](../00-baseline/裁决R54.md) **两级处置**：
> **删**探针代码 50 个 / 405.6 KB、**留**结论与证据 56 个 / 351.8 KB（登记为 `record`/`archive`）。
> 实测**只有 1 处 md 链接指向被删的代码**（已改成"原路径 + 括注"）⇒ 删除**不产生悬空链接**；
> L1→新归档的 17 处链接补齐 `（历史实测）` ⇒ **总错误仍 6**、**警告 3 → 1**（N5 的"提及失效路径"经**继承式**
> 白名单闭合）。[DOC-SPEC](../DOC-SPEC.md) §4.5 同步由"满足三条件后整体删除"改为"**两条件 / 两级处置**"。
>
> **D10 收口了 P2 的文档侧**：把剩下的 **6 条存量跨层**（46 行 / 61 处链接）按目标种类规则化补标记词
> （存档 →（依据）、附录/记录层 →（细则）、基线件 →（原文口径）；已有括注的**折进去**而不是并排两个）⇒
> **跨层 error 6 → 0**，**`check-docs.mjs` 首次十类全绿**（`exit 0`）。验收⑤ 的人工通读**先做成 4 条机械判据**
> （裸指路词 **0 / 205 处**、"定义落归档"仅 1 处且经判定可接受、无指路密度超标、台账覆盖被引用的 **56 个**裁决编号），
> 再逐份读必读件——**抓到 1 个真缺陷**：当前规划 G8 出口条件表**编号缺 ④**（D4 回写判定时把归档里两条并成了一行 ③）
> ⇒ 拆回两行、①–⑨ 与归档逐条对齐；当前规划 **11.995 KB**（≤12 KB，**余量仅 5 字节**，已顶到预算边界）。
> 实测：**精简层 480.2/500 KB**、**必读 33.1/34 KB**、**存档 53 轮（R02–R54）**、`test` **55 spec / 809 例**；
> **余下的红只有常量 31 处（全在代码侧 ⇒ P3/C5）**。
>
> **P3/C1（`scripts/` 公共基建）已完成**：新增 [`scripts/cdp.mjs`](../../scripts/cdp.mjs)（启动 / 端口等待 /
> CDP 客户端 / 静态伺服）与 [`scripts/paths.mjs`](../../scripts/paths.mjs)（`repoRoot` + `rel` 单点）；
> 三个 Chrome 脚本共减 **400 行**（`measure-render` 1,907→1,760、`smoke-build` 1,524→1,374、
> `offline-artifact-probe` 665→562），`repoRoot` **12 处** / `rel()` **3 处**改 import，
> 各自的模式差异（窗口尺寸、`--disable-gpu`、`file:` 目标优先、Edge 回退、是否删 profile）全部作参数。
> 顺带订正 `measure-render` 的证据视口口径（`--window-size=1280,640` 残留一并删除）。
> 实测：`lint` / `typecheck` / `test`（55 spec / 809 例）/ 三步 Chrome 门禁 / `selftest` 39 项全绿，
> `check-docs` 十类 `exit 0` 与改动前逐条相同、常量仍 **31 处**（⇒ C5）；测出一个**既有**的首帧竞态
> （抽取前后 A/B 各两次证明与本批无关）并登记为 `N11`。详见 [批次记录-P3](06-批次记录-P3.md) 的 §C1。
>
> **P3/C2（`packages/xlsx-protocol`）已完成**：删 **8 个全仓零引用的导出**；合并五处重复实现
> （`SheetView` 构造、依赖文本格式化、zip 条目遍历四处、ISO 日期构造、诊断构造）；把
> `RowParseResult` 暴露的可变 `DiagnosticBag` 收成**只读视图** `ReadonlyDiagnosticBag`；
> 订正 `PROTOCOL.md` 的 4 处失真（入口个数、不存在的 `templateSheetNames()`、"导出遇环"、
> `exceljs` 体积口径）与说明页里一条严重度文案（warning → info，模板字节数随之 11,668 → 11,673）。
> 实测：xlsx 侧 **9 spec / 94 例**全绿（例数未增未减）、openpyxl 双向差分仍跑、`lint`/`typecheck`/`build` 绿、
> `check-docs` 十类 `exit 0`（常量侧仍 31 处 ⇒ C5）、`smoke:build` 绿（模板字节数变了，重跑一次端到端回导）。
> 顺带订正计划里两处归属（`TemplateEdge` 属 C3；`diagnostics.ts` 的"21 条"已由 D6-a 清掉）。
> 详见 [批次记录-P3](06-批次记录-P3.md) 的 §C2。
>
> **P3/C3（`packages/pptx-renderer`）已完成**：1,046 行的 `template.ts` 按职责拆成 `template/` **九个文件**
> （多出一份 `container.ts`：与 pptxgenjs 的唯一接触面）；两处去重收敛（XML 转义 → `render-core` 的
> `escapeXml`、行标签 → `exportLabelOf`）；删 `void left;` 与其无用局部、spec 里的空操作 `replace`、
> 零引用的 `TemplateEdge`；`PPTX.md` 五处失真订正（模块表、门禁表编号、中心差三值不一、`SPACING` 归属、
> golden 标注为记录值）；`engine` 移到 `devDependencies`。
> **实测：产物逐字节不变**——周档 16,169 字节 / sha256 `a13f17be…6352`、日档 17,627 / `78aa0773…4ae8`，
> 与拆分前逐项相同；`template.spec.ts` **16 例**绿、全仓 **55 spec / 809 例**绿、`lint`/`typecheck`/`build`/
> `license:check`/`smoke:build` 绿、`check-docs` 十类 `exit 0`、常量仍 31 处（⇒ C5）。
> 详见 [批次记录-P3](06-批次记录-P3.md) 的 §C3。
>
> **P3/C4-a（`packages/engine` 的去重/死码/规范订正/测试侧搬迁）已完成**：六类重复 helper 各收敛到一处
> （`assertWorkDays` → `date.ts`、`fail` 拆成 `throwRangeError`/`failureOf`、`isIsoDateText` → `date.ts`、
> 诊断入栈 → `wbs.pushDiagnostic`、JSON 守卫 → `isRecord`（宽松）/`isPlainObject`（严格）、
> JSON 值校验统一判定谓词）；删死码三处（`assertOutlineNumber`、`CALENDAR_NOT_REFERENCED`、
> 两个日期**别名**——后者实测有 5 个 `render-core` 消费点，先迁到规范名再删）；`loopCalendar.ts` 迁到
> `test/`；`PERSISTENCE.md` 改正 4 个签名 + 事件联合（无 `count`）+ 两个「## 五、」+ 不变量 ④（多标签
> 只在降级路径成立）、`SCHEDULE.md` 补结果类型的 `renderCalendar`；`SCHEMA.md` 的两处**实测与代码一致**
> ⇒ 不改、只记录。
> 实测：engine **24 spec / 407 例**全绿（含差分与性能判据）、全仓 **55 spec / 809 例**绿、
> `lint`/`typecheck`/`build` 绿、`check-docs` 十类 `exit 0`、常量仍 31 处（⇒ C5）。
> **C4 按细粒度分批拆成 a/b/c**：b（拆 `schema.ts`）与 c（拆 `persistence.ts`）未做。
> 详见 [批次记录-P3](06-批次记录-P3.md) 的 §C4-a。
>
> **P3/C4-b（拆 `schema.ts`）已完成**：`schema.ts` **1,512 → 1,346 行**，新增 `src/migration.ts`（168 行）
> 承载 v1→v2→v3 逐跳迁移、注册表、v2→v3 专用的编号遍历与 `DocumentVersionError`；驱动 `migrateDocument`
> 留在 schema（它要用 schema 的版本读数机制），公共面原样再导出、依赖方向单向无环。
> 那条"第三遍编号遍历"经实测是**刻意的差异**（脏数据退回位置编号，交校验报 `TREE_*`）⇒ 保留差异、写明理由，
> 并补一条用例钉住（`schema.migration.spec.ts` 21 → 22 例）。
> 实测：engine 408 例全绿、全仓 **55 spec / 810 例**绿、`lint`/`typecheck`/`build` 绿、`check-docs` `exit 0`、
> 常量仍 31 处。**C4-c（拆 `persistence.ts`）未做。** 详见 [批次记录-P3](06-批次记录-P3.md) 的 §C4-b。
>
> **P3/C4-c（拆 `persistence.ts`）已完成 ⇒ C4 收口**：883 行的单文件按职责拆成 `src/persistence/` 六个文件
> （`types` 158 / `record` 283 / `guards` 192 / `policy` 214 / `memory` 80 / `index` 40），
> 逐符号再导出 ⇒ **公共面与原 `persistence.js` 完全一致**；依赖方向单向无环。
> 实测：engine 408 例全绿、全仓 **55 spec / 810 例**绿、`lint`/`typecheck`/`build` 绿、`check-docs` `exit 0`、
> 常量仍 31 处（⇒ C5）。详见 [批次记录-P3](06-批次记录-P3.md) 的 §C4-c。
>
> **P3/C5-a（常量单点化 + align 内部入口）已完成 ⇒ 红窗闭合**：31 处常量重述**全部**改成"指回声明处"
> （`svgExport.ts` 的 `COLOR` 表引用 `manifest.ts` 的 `AXIS_*`；条色迁进 `manifest.ts` 并同步检查表；
> `TaskTable.vue` 走 **CSS 变量通道**；`GanttChart.vue` 的刻度长度 / STUB / 条色改从包入口取；
> `count.ts`/`interaction*`/`scaleInvariance`/`measure-render` 的 `c₃`/`c₄` 复述改为指针）
> ⇒ **`check-constants` 首次 `exit 0`**、`pnpm docs:check` **全绿**（P1 设计的红窗就此闭合）。
> 另按三项裁决落地：刻度长度**保持 `svgExport.ts` 为声明处**；`align` 一族经**内部子路径**
> `@ganttpilot/render-core/align` 暴露（**只挪这一族，其余 296 个导出一个不删**）。
> 实测：全仓 **55 spec / 810 例**绿、`lint`/`typecheck`/`build`/`check-docs`/`check-constants` 全绿。
> 顺带订正两处计划误记（轴层序那句在 **`clip.ts`** 而非 `manifest.ts`；Jaccard `0.3023` **已被
> `arrows.spec.ts` 钉住**），并登记一条实测发现（**spec 不在 tsc 程序内** ⇒ 未定义标识符只在运行时翻红，登记为 N12）。
>
> **P3/C5-b（拆 `gesture/` + 删两处同义死码 + 悬停行带的非 0 滚动用例）已完成 ⇒ C5 收口**：
> 1,358 行的 `gesture.ts`（11 项职责）拆成 `src/gesture/` 六个文件（`pointer`/`candidates`/`outcome`/
> `linking`/`state` + 桶 `index`），**公共面逐符号不变**（判据是"代码行多重集比对"：80 条差异逐条都是
> 加 `export`／换 import／搬声明）；`zones.ts` 的 `zoneContains` 撤出公共面（转模块内私有）、
> `clip.ts` 的 `isRenderedRow` 删除并内联进 `isRowRendered`（**公开值导出 210 → 208**，与决策 3C 的
> "入口归属"口径差别见 C5-b 记录）；悬停行带补 `scrollLeft = 600` 用例（决策 7）⇒ **绿，非行为变更**。
> 另**订正两处计划误记**（"不重复发 `gridline`"不是与代码相反、而是"只说了一半"，代码有"上级补发"那一半；
> `SPEC.md` 的 `§九` 引用按名是对的、写法有歧义）与一处同族收敛（`DragMode` 两处声明 → 只住 `zones.ts`）。
> 实测：全仓 **55 spec / 811 例**绿、`lint`/`typecheck`/`build`/`smoke:build`/`check-docs`/`check-constants` 全绿。
> 详见 [批次记录-P3](06-批次记录-P3.md) 的 §C5-b。
>
> **P3/C6-a + C6-b（测量脚手架）已完成 ⇒ `apps/web` 的第一块**：按裁决 **②** 把 2,625 行的
> `measure.ts` **就地拆成 `src/measure/` 七个模块 + 门面**（公共面逐符号相同；判据是"剥掉 import/export 表后
> 代码行多重集比对：1,824 / 1,824，22 条差异逐条都是补一个 `export` 前缀"；打包形状不变，仍是同一个懒 chunk），
> 并把"零业务逻辑"的**唯一实例**（抓取点公式三份实现）收进 `render-core` 的 **`workdayCellCenterX`**
> （`milestoneCenterX` 改为委派 ⇒ 13 条几何期望值仍逐位绿）；随后修掉 **N11**：根因是**写入顺序**
> ——初始会话恢复（IndexedDB，按 origin 隔离）会在**同一次运行的后续导航**里把文档换回上一次的基线，
> 若落在夹具装载之后 ⇒ DOM 15/14 vs 模型 31/41。修法：`usePersistence` 暴露 `restoreSettled`、
> `loadDocument` 等它结算再装夹具（**夹具是最后一个写入者**；`await` 在计时起点之前 ⇒ 口径不变）。
> **确定性 A/B**：修前逐字复现 N11 的历史报文、修后 `errors: []` 且 `domCounts == counts`；
> 正常路径下主口径 ×2 / `--drag` / `--align` 三族全绿（证据按先例不改写）。
> 详见 [批次记录-P3](06-批次记录-P3.md) 的 §C6-a / §C6-b。~~**C6 余下**：领域逻辑下沉、拆 `App.vue`、死码（`N14`/`N15` 与记录制入口公共化）、仓内格式。~~
> **该判断已过期**（保留原句以示当时的排期）：`N14`/`N15` 由 **C6-d** 闭合、领域逻辑下沉由 **C6-e**、
> 拆 `App.vue` 由 **C6-f** ⇒ **C6 只剩下 `g` 收尾**（死码 + 格式化器裁决）。
>
> **P3/C6-c（命名与死码：测量侧去掉能力块代号）已完成**：按维护者指出的口径——**能力块代号可以当
> "记录指针"（如"G8 复验第 ③ 条"），不可以当标识符**——把 `measure/g8.ts` → `measure/axisHover.ts`、
> `G8MeasurementHost`/`G8MeasureResult` → `AxisHover*`、`__GANTTPILOT_MEASURE_G8{,_META,_ERRORS}__` →
> `__GANTTPILOT_MEASURE_AXIS_HOVER{,_META,_ERRORS}__`（页面与 `offline-artifact-probe.mjs` 同改；
> **记录制侧实跑 `probe:offline` 验证协议没断**）。**顺带查出两件事**：① 那个"记录制 G8 读数口"
> **从来没有驱动器**——`measure-render.mjs` 没有 `--g8`，而门禁侧已由 `smoke:build` 直接读 DOM 覆盖
> ⇒ 登记 **`N15`**（建议补驱动器，与 `N14` 同批）；② `smoke-build.mjs` 的注释写着"记录制侧是
> `measure-render.mjs --g8`"——**那句话从未兑现**，已按实情改写。另清掉四处仓内格式粘连。
> 详见 [批次记录-P3](06-批次记录-P3.md) 的 §C6-c。
>
> **P3/C6-d（记录制入口公共化 + 钩子版本兑现 + 刻度/悬停驱动器）已完成 ⇒ `N14`/`N15` 双双闭合**：
> `measure-render.mjs` 新增 **`openMeasuredPage`**（导航 → 等就绪 → **核对钩子版本**），**四处**重复的就绪循环
> 收成一处；`MEASURE_HOOK_VERSION` 挪到门面、值改 `'2026-10-08'`（代号不是功能语义），页面先报版本、
> 入口要求非空（空 ⇒ 判红"测的可能是更旧的产物"）、并登记进证据的 `环境` 块（**脚本不硬编码版本**）。
> 新增 CLI 模式 **`--axis-hover`**（**不叫 `--g8`**）作为那个"零调用方读数口"的驱动器：逐档位在左表在场的
> 打包产物上读两级刻度与悬停行带 + **五条前提自证**（判据本体仍在门禁的 `probeAxisAndHover`）。
> 实测：`--axis-hover` 三档全绿（上级 `YYYY-MM`/`YYYY`、下级 `DD`/`MM-DD`、大刻度在上、行带跟着指针走、
> 左表底色 `transparent → rgb(207, 227, 250)`）；四处被重构的就绪循环逐一复验（主口径 / `--align` /
> `--persist-drag`）全 `exit 0`；**首次快照不入库**（P4 集中重取一次）。
> **C6-e 已做**（领域逻辑下沉 → 见 [批次记录-P3](06-批次记录-P3.md) §C6-e）：`computeDepths` **先比对再换**，
> 比对当场抓出**引擎自己也不自洽**（悬空 `parentId` 时整条链归 0）⇒ 先把引擎修到与 `buildTaskTree`
> 同一根判定（悬空/自指是根、长度 ≥2 的环 ⇒ 0、不设深度上限、O(n²) → O(n × 深度)），再让左表用它；
> 列宽整段收回 `render-core/columns.ts`；`ARROW_FILL` / `previewStubX` / `conflictTaskIdsOf` 各归其位；
> 新增门禁判据"名称格内边距 == (WBS 段数 − 1) × 12"（带负向对照）；顺带订正一个**从没人算过的数**
> （"九列合计 992 px" 实为 **909**）。新登记 `N16`（预览箭头朝向与落地可能相反，实测 3/8 类形状）。
> **C6-f 已做**（拆 `App.vue` → 见 [批次记录-P3](06-批次记录-P3.md) §C6-f）：**1,359 → 795 行**
> （`script` 段 998 → 433），五块各自成 composable（`useChartPointer` / `useHover` / `useKeyboardShortcuts` /
> `useDiagnostics` / `useImport`），**测量宿主 250 行单独成模块 `measureHost.ts`**——它是**懒加载**模块
> （`App.vue` 只 `await import('./measureHost.js')`，宿主自己 static import `measure/index.js`），
> 因此分包纪律不变：实测首屏主 chunk **+0.08 KB**、主 chunk 里 `GANTTPILOT_MEASURE` 与 `pptxgen` 均**不出现**。
> 五条记录制通道（主口径 / `--align` / `--drag` / `--axis-hover` / `--persist-drag`）全部重跑通过，
> 证据按纪律不入库。顺带把 `measure/*` 与离线探针里 11 处指向 `App.vue` 的**活指针**改到新住所。
> **C6-g 已做**（收尾 → 见 [批次记录-P3](06-批次记录-P3.md) §C6-g）：两处零消费者导出按 C5-b 先例删除
> （`useChart.ts` 的 `pxPerDayOf`、`render-core` 的 `highlightForConflict`——后者连带**收窄 `HighlightSet.styleKey`**
> 的联合，去掉只有它会产出的 `drag-conflict`，并同步 `SPEC.md` 的模块行）；**格式化器不引入**，
> 口径写进 [CONTRIBUTING](../../CONTRIBUTING.md) 的「代码格式」节（七处粘连全是人眼发现的 ⇒ 它是缺陷、
> 改由评审守，并写明何时该翻这条裁决）。**[05 §四.7](05-登记与本轮不做.md) 随之闭合**。
>
> **⇒ C6 到此收口（a–g 七批）。** P3 余下：[03 §八 C7 工程配套](03-代码重构.md)（lint 护栏方向、工具链类型检查、
> 根 `tsconfig`、`chrome-harness.selftest` 进门禁、`tmp/` 清理、`.gitignore`）与
> [03 §九 C8 证据卫生](03-代码重构.md)（零引用 raw、raw 的引用关系、重复 PNG、evidence 层的 `layer` 登记）。
>
> **P3/C7-a（依赖方向：从口头约定到会失败的断言）已完成**：`eslint-rules.mjs` 新增 `CALCULATION_LAYER_PACKAGES`
> （四包逐条 `allowed` + 依据），`eslint.config.mjs` 由它生成**逐包方向块**——`engine` 允许 `[]`
> ⇒ "engine 不得依赖 render-core"从此是**会失败的断言**（此前 `packages/engine` 里 import `render-core`
> `pnpm lint` 全绿）。同批现场实测出**三处假绿**并一并闭合：① 工作区依赖零规则；② `xlsx-protocol`/`pptx-renderer`
> 的夹具**没有任何自检加载**（已并入引擎那份"护栏自检"并补 DOM 夹具）；③ `FORBIDDEN_FRAMEWORKS` 的
> `vue/*`/`@vue/*` 在 `paths` 下**空转**（改用语义等价的 `patterns`，取值一字未改）。契约与事实各守一半：
> lint 守「代码 ⊆ 契约」，自检守「声明 ⊆ 契约」+「`packages/` 下每个目录都已登记」。
> **`06` 已触到 `record` 层 80 KB 上限 ⇒ 本批另开 [批次记录-P3-C7](07-批次记录-P3-C7.md)**（同 P2 的拆分规矩，
> 不抬上限）；`N17` 随之闭合。详见该文件 §C7-a。
>
> **P3/C7-b（spec 进 tsc 程序：引擎先行）已完成**：`packages/engine/tsconfig.check.json` 不再继承**构建**项目
> （那份 `rootDir: src`、`exclude: spec`），改为 `extends tsconfig.base.json` + `include: ["src/**/*.ts","test/**/*.ts"]`
> ⇒ **spec 与测试侧参照实现都进了 tsc 程序**，`N12` 的引擎侧闭合：**21 处错误 → 0**，其中**三处是真缺陷**
> （① `test/loopCalendar.ts` import 了 `src/date.ts` 里**没有 export** 的 `throwRangeError` ⇒ 4 条错误路径
> 实际抛 `TypeError`，而三道静态门全绿；② `wbs.spec.ts` 的负向对照夹具把**整条数组**当任务，断言只看另一半
> ⇒ 用例一直绿；③ `saveCheckpoint` 要求调用方给 `id`、而 `id` 由存储实现分配 ⇒ 登记为 **`N18`**）。
> 负向对照：spec 里写未定义标识符 ⇒ 新程序 `TS2304` 翻红，而 `tsc -b` 与 `eslint` 都退出 0。
> 同批把**配置本身**变成可类型检查的（`eslint.config.mjs` 的 `Linter.Config[]` 标注；`eslint-rules.d.mts`
> 的返回类型改用 `Linter.RuleEntry`——**新程序上线第一件事就是抓到 C7-a 声明里的不诚实**）。
> 其余三包（实测 34 / 4 / 2 处）按**逐包可交付**排 C7-c/C7-d，门禁始终绿。详见 [批次记录-P3-C7](07-批次记录-P3-C7.md) §C7-b。
>
> **P3/C7-e + C7-f + C7-g 已完成**（工程配套的三件收尾）：
> **C7-e** 让根 `tsconfig.json` 从**装饰**（`files: ["vitest.config.ts"]` + 四条 `references`，还漏了 `apps/web`）变成
> **真的被使用的工具链程序**（护栏定义/声明、ESLint 配置、vitest 配置、两个 vite 配置、`scripts/paths.mjs`，
> `allowJs` + `checkJs`），并由 `typecheck` 先跑它；上线**当场抓到** `vitest.config.ts` 的 `minWorkers`
> **在 Vitest 5 的 `InlineConfig` 里不存在** ⇒ 它从写下那天起什么也没做（"限并行度"只由 `maxWorkers: 2` 生效）；
> `scripts/**` 的其余部分实测 **489 处**、按"逐文件 JSDoc"登记为 **`N19`**（**不**用 `noImplicitAny: false` 放宽）。
> **C7-f** 把 `chrome-harness.selftest.mjs` **转成 vitest spec**（39 项检查 → 18 个用例）⇒ 不可逆收尾闸的唯一回归测试
> 随 `test` 步进 `pnpm gate`，而 **`STEPS` 与"九步"契约一字未动**；负向对照**先证明我第一版转换没牙**
> （`await` 会把 Promise 拆开 ⇒ `typeof` 仍是 `string`），改成不 `await` 后才真的拦得住。
> **C7-g** 给 `tmp/` 加了挂在**所有拉起路径唯一入口**上的 profile 回收（24 h 年龄窗口）：
> **一次调用实测回收 60 个 profile / ≈754 MB / 18,494 文件**（1,181.7 → 427.6 MB，1,980 ms）；
> 并把 `.gitignore` 里"注释声称了、规则却没有"的 `*.pptx` / `*.xlsx` 补齐。
> 详见 [批次记录-P3-C7](07-批次记录-P3-C7.md) §C7-e / §C7-f / §C7-g。
>
> **P3/C7-d（`packages/xlsx-protocol` 的 spec 进 tsc）已完成**：该包 `tsconfig.check.json` 改成与引擎同形后
> 4 处错误清零，其中**一处是真缺陷**——差分的失败信息模板取 `expected.wbs`，而夹具里根本没有这个字段
> ⇒ 一旦差分失败，报错退化成 `第 3 行（WBS ）`；另一处是 `views[0].ySplit`：`WorksheetView` 是**联合**、
> `Partial` 分发后 `ySplit` 结构性不可见，**先用探针证明断言不是假绿**（导出的 XML 里确有
> `<pane ySplit="1" state="frozen"/>`、`xlsx.load` 读回 `ySplit === 1`），再用 exceljs 自己的判别式 `state` 收窄。
> 实测 9 文件 / 94 例例数不变、全绿。详见 [批次记录-P3-C7](07-批次记录-P3-C7.md) §C7-d。
>
> **P3/C7-c（`render-core` + `pptx-renderer` 的 spec 进 tsc）已完成 ⇒ `N12` 四包全闭合**：
> **35 + 2 → 0**（并**纠正** C7-a 记的底数：render-core 是 35 不是 34，多出来的正是 `TS7016`）。
> 三处真缺陷：`export.spec.ts` 的 `schedule` 字段条件类型**塌成 `never`**（`.milestoneCount` 从未被检查过）；
> `gesture.spec.ts` 的 `CONNECT_SIZE_PX` 取自**不 re-export** 它的 `interaction.js` ⇒ 4 处指针 x 全 `NaN`，
> 而用例仍绿——**核对过的机制**是那四处都显式给了 `entryPoint`，`x` 从不进入被判定的值（判据着力点错位，
> 已如实记录而不顺手改断言）；`dateTextNegative.spec.ts` 传了一个**从来不存在的字段** `unanchored`
> （探针：补上 `calendar` 后 `differences = 981/1000` ⇒ 断言现在名副其实）。
> 另有本批最有价值的一段——**测试侧手段的落点三跳**：`*.spec.ts`（vitest 会把被 import 的 spec 的用例按 importer
> 各算一遍 ⇒ 297 → 387）→ `src/*.testkit.ts`（被编进 `dist/`，而包是 `files: ["dist"]`）→ **`test/*.testkit.ts`** ✓
> （与 `packages/engine/test/` 同形，dist 里零测试文件、用例数一个不变）。详见 [批次记录-P3-C7](07-批次记录-P3-C7.md) §C7-c。
>
> **P3/C7-h（三项误导性改名 + PPTX golden 重锚）已完成 ⇒ C7 收口（a–j 十批）**：按维护者裁决"三个都改"——
> `PLANNED_GATE` → **`LATEST_COMPLETED_BLOCK`**（9 处 / 8 文件；值跟踪"最新**已完成**能力块"，而 `GATE` 在本仓专指质量门禁）、
> `align.ts` 的 `round`（3 位小数）→ **`roundSubPx`**、`svgExport.ts` 的 `round`（取整）→ **`roundPx`**、
> `NAMES.progress` 的 `prog-` → **`progress-`**（形状名要在 WPS 里读得出来）。**代价如实接受**：形状名进 XML ⇒
> 产物字节变 ⇒ **golden 重锚**（周档 16,169 → **16,175** / `f843f2d0…`；日档 17,627 → **17,635** / `269bdc1e…`，
> live 值见 `PPTX.md`），且**机械证据**是把新产物的名字改回旧名后重打包、**逐位复现旧锚值**（两档都成立）
> ⇒ 差额 100% 来自改名；另有**一批记录制证据作废**（`template-a-demo-wps.md` 的 53 处 `prog-*`、三份 `wps/*.xml`、
> `roundtrip-addendum.md` 的旧锚值、两张 vision PNG）交 **P4 集中重取**。顺带补两处"名字没有守卫"的口子：
> `index.spec.ts` 增 `NAMES.progress` 断言、`wps-pptx-verify.ps1` 的报告文案改新前缀。
> **⇒ 接着做完 [03 §九 C8 证据卫生](03-代码重构.md)（a–d 四批）**，P3 到此收口；C8 的实测与三处计划订正
> 见 [批次记录-P3-C8](08-批次记录-P3-C8.md)。**P3 全部批次走完**，下一步是 [验收与门禁](04-验收与门禁.md) 的 **P4**（文档↔代码核对 + 记录制证据集中重取一次）：
> 它的批次切分已补在 [验收与门禁](04-验收与门禁.md) §六（**a–e 五批**：规范↔导出面的机械核对 / 公开 API 面分类 + `N13` 标签同步 / golden 钉子 / 记录制证据集中重取 / 三件套与收口）。
> 两条实测边界（2026-10-08）：**精简层 493.1/500 KB、必读 33.1/34 KB 已顶边** ⇒ P4 的记录只进记录层
> （另开 `docs/04-refactor/09-批次记录-P4.md`，不追加已 76.8 KB 的 `06`）；**重取那一步必须在有 Chrome + Python 3 的机器上做**。
>
> **P4-a 已完成**（判据 ① 的机械那一半）：新增 [`scripts/check-api-surface.mjs`](../../scripts/check-api-surface.mjs)
> （**10 例**自检）与 `doc-index.json` 的 `apiSurfaceCheck`（10 个 target + 候选数下限），进 `pnpm docs:check` 的第三步，
> 规范落点 [DOC-SPEC](../DOC-SPEC.md) §4.7。**负向对照**：未加例外时现状恰好 **1 条 error**
> ——`PROTOCOL.md:33` 点名 `XlsxInput` 而 `xlsx-protocol` 入口不导出它（与 06 §C2 的登记逐字一致），
> 按计划**留给 P4-b 的公开面分类**（登记为带 reason 的例外，且每次都打印）；其余 **88 个被点名的符号全部命中**。
> 同批把 `01 §五` 的失真清单**逐条重新实测**：3 条已闭（`renderCalendar` / `templateSheetNames` / 两个「## 五、」）、
> 1 条**P0 说法不成立**（空 `workDays` 实测是 `error:CALENDAR_INVALID`，文档与代码一致）、
> 3 条当场修（`PERSISTENCE.md` 的目录形态 + 流程图 4 处签名 + §三 表 1 处签名；`PPTX.md` 门禁表补上缺号 ⑧；
> `SPEC.md` 的 `interaction.spec.ts` 补"当前 27 例"）。实测：**57 spec / 846 例全绿**、`lint`/`typecheck`/`docs:check` 绿。
> 详见 [批次记录-P4](09-批次记录-P4.md) 的 §P4-a。
>
> **P4-f（精简层结构复核）已完成**（维护者插入批，先于 b–e）：先量后判——精简层 **495.8/500 KB** 的构成是
> **契约 222 + 包规范 165 + baseline 76 + 登记 20 + 判定 13 KB**，逐份套五层模型与反重复规则后
> **没有一份文档该进记录层**（包规范的验证矩阵由反重复规则 2 显式指定住契约层 ⇒ 那 20 KB 的杠杆属改决策）；
> 跨文档重复实测只剩 **3 组 / 0.4 KB**。故只做**子句级下沉**：`PPTX.md` 的 golden 沿革与首版缺陷、
> `render-core/SPEC.md` 的报文原文与视口宽症状、ADR 0007 §11 的溯源叙述、台账 §一 的迁移理由
> ⇒ 全部落进**附录**（[0010 §3](../02-adr/附录/0010-增补.md) / [0007 §11](../02-adr/附录/0007-增补.md)）
> 或**已在**的记录层（`R52` / [G6–G8 记录](../01-roadmap/首版-记录-G6-G8.md)），**没有一处是直接删掉**；
> 另把 `CONTRIBUTING` 的格式化器一节改成**自足**（不再指向会随合流删除的计划目录）。
> 实测：**精简层 495.8 → 493.4 KB、必读 33.1 → 32.9 KB**，`docs:check` 绿。
> 详见 [批次记录-P4](09-批次记录-P4.md) 的 §P4-f。

**分批纪律（决策 1：细粒度分批）**：每阶段拆成**可独立 review 的小批**，**一批一个提交**，批与批之间不留半成品。
批次切法在各阶段文档的「批次切分」节给出（**P1 无独立阶段文档，其批次表见 [验收与门禁](04-验收与门禁.md) §一**）；每批的验收标准在 [验收与门禁](04-验收与门禁.md)。

## 三、每一批都必须满足的不变量

1. **对外功能与接口行为不变**。确需变更的，逐条登记后单独裁决——本轮已裁决两条为
   **「降级文档、未来实现」**（见 [基线与决策](01-基线与决策.md) §四）。
2. `pnpm test` **55 spec / 809 例全绿，例数不减**（除非有裁决允许删减）。
3. `pnpm docs:check` 全绿。
4. **承重判据不许放宽**：`c₃` 逐档位、元素预算两路互证、`scaleInvariance` 的"同档位恒定"、
   性能 `medianP50 ≤ 1 ms` 且 `medianP99 ≤ 2 ms`。若它们翻红，**动作是隔离或修实现，不是改数值**。
5. **记录制证据集中重取一次**，不许零散作废（纪律见 [验收与门禁](04-验收与门禁.md) §证据）。

## 四、分支与环境

| 项 | 值 |
|---|---|
| 分支 | `refactor/v0.2` |
| 基点 | `main` 的 `c74ad52`（**注意：`v0.1.0` tag 指向 `ad48327`，比基点早一个提交**） |
| 合流目标 | `main`，合流后打 `v0.2`（annotated，报文即发布说明初稿，沿用 v0.1.0 的做法） |
| 本地门禁 | `pnpm gate`（九步）；其中 3 步需本机 Chrome、2 步需 Python 3 + `openpyxl==3.1.5` |
| 远端 CI | 9 步中的 6 步，**比本地门禁弱**（补哪两步见 [登记与本轮不做](05-登记与本轮不做.md) §二） |

> **P5 的硬条件**：`c74ad52` 把 `build` 前移到 `typecheck` 之前，属**正确性修复**，但它**从未在干净检出上跑绿过**
> （`v0.1.0` 仍带旧序）。合流前必须确认 CI 在干净检出上真的绿——这是"稳定"的一部分，不是可选项。
