# S2 · L1 判定报告（规范工作簿的自往返与编码落地）

> 由 `node src/run-all.mts` 生成。本报告只覆盖**本机 ExcelJS + zip 层**的结构判定，
> **不覆盖**第三方编辑器（WPS）往返——后者见 `evidence/<label>/roundtrip-report.md`。
> 重跑会**覆盖**本文件；判定集与负向对照的代码在 `src/verify-l1.ts`。

运行环境：Windows x64、时区 UTC+08:00（系统默认）；**Node 24.15.0（`.nvmrc` 与 CI 口径）
与 Node 26.7.0 上均已跑通，结论相同**。此处刻意写固定字符串而不写 `process.version`，
以保证换运行时重跑时证据文件逐字节不变。

| 项 | 值 |
|---|---|
| 工作表 | 任务（单表，可见，无隐藏表） |
| 日期编码 | `serial` |
| 里程碑编码 | `boolean` |
| fixture | 28 行 / 16 条边 / 最大深度 2 / 里程碑 4 |
| 规范化产物 | 8892 字节，**部件指纹** `084936632dcc8ab8a177c1fc2a9c2a7036d494b1bb68a4fa466ad3c0cc4ceba8`（10 个部件） |
| 确定性 | 同一模型两次写出的**部件内容逐字节相同**：✅；整文件字节也相同（同秒写入） |
| 单元格数 | ExcelJS 对象层 214 / zip 层 214（共享字符串 94 条，部件 10 个） |

> **关于「确定性」**：`exceljs@4.4.0` 会把**写入时刻**写进 zip 条目的 DOS 时间戳，
> 因此**整文件字节**在不同秒写入时不相等（部件内容相同）。golden 比对（G3/G7 同类要求）
> 必须比对**部件指纹**，不能用文件哈希——否则会得到「永远不一致」的假失败。

### 判定集

共 15 条，通过 15 条，失败 0 条。

| 检查 | 结果 | 实测 |
|---|---|---|
| `header-row（表头文本与列序）` | ✅ 通过 | 第 1 行：WBS \| 任务名称 \| 开始 \| 完成 \| 工期 \| 前置任务 \| 进度 \| 里程碑 \| 备注（共 9 格） |
| `raw-cell-types（编码确实按声明落盘）` | ✅ 通过 | 28 行的列类型与数字格式全部符合声明 |
| `dual-path（ExcelJS 对象层 vs zip 原始层逐格一致）` | ✅ 通过 | 214 格完全一致 |
| `field-equality（ExcelJS 路径解析值 vs 声明式期望值）` | ✅ 通过 | 28 行 × 7 字段全部相等 |
| `edge-equality（依赖边集合 vs 声明式期望边）` | ✅ 通过 | 16 条边完全一致 |
| `raw-path-agreement（zip 路径解析值 vs ExcelJS 路径解析值）` | ✅ 通过 | 两条读取路径的解析结果逐字节相同 |
| `indent-not-semantic（清空缩进后解析结果不变）` | ✅ 通过 | 剔除缩进字段后，解析结果逐字节相同 |
| `indent-matches-depth（WBS 编号可独立推导层级）` | ✅ 通过 | 28 行的缩进与 WBS 深度一致 |
| `formula-prefix-text（= + - @ 前缀文本按字符串往返）` | ✅ 通过 | 4 行（5.2、5.3、5.4、5.5）逐字符一致且落盘为字符串 |
| `diagnostics-empty（结构化诊断为空）` | ✅ 通过 | 无诊断输出 |
| `determinism（同一模型两次写出的**部件内容**逐字节一致）` | ✅ 通过 | 部件指纹 `084936632dcc8ab8…`（10 个部件）；整文件字节**也**相同（同秒写入） |
| `sheet-meta（单表、可见、无隐藏表、1900 日期系统）` | ✅ 通过 | 表=[任务/visible]，日期系统=1900 |
| `fixture-coverage（样本覆盖四类关系、负/零/正 lag、多层与空日期）` | ✅ 通过 | 行=28、边=16、最大深度=2、里程碑=4、无日期行=7、关系=FF/FS/SF/SS |
| `date-representations（日期列落盘形式分布）` | ✅ 通过 | 期望为空 × 14；数值序列号（yyyy-mm-dd） × 42 |
| `negative-control（变造必被报出）` | ✅ 通过 | NC1 日期单元格改成文本型（C3）：已报出；NC2 日期序列号 +1 天（C3）：已报出；NC3 进度值被改（G6）：已报出；NC4 表头「前置任务」被改名：已报出；NC5 删掉第 29 行：已报出 |

### 负向对照（变造必须被报出）

| 变造 | 变造内容 | 期望被判据拦下 | 实际报出的失败检查 | 判定 |
|---|---|---|---|---|
| NC1 日期单元格改成文本型（C3） | 把 C3 的落盘类型从数值改为 t="str"（日期写成文本） | raw-cell-types（编码确实按声明落盘） | raw-cell-types（编码确实按声明落盘）、dual-path（ExcelJS 对象层 vs zip 原始层逐格一致）、field-equality（ExcelJS 路径解析值 vs 声明式期望值）、raw-path-agreement（zip 路径解析值 vs ExcelJS 路径解析值）、diagnostics-empty（结构化诊断为空） | ✅ 已报出 |
| NC2 日期序列号 +1 天（C3） | 46300 → 46301 | field-equality（ExcelJS 路径解析值 vs 声明式期望值） | field-equality（ExcelJS 路径解析值 vs 声明式期望值） | ✅ 已报出 |
| NC3 进度值被改（G6） | 0.5 → 0.75 | field-equality（ExcelJS 路径解析值 vs 声明式期望值） | field-equality（ExcelJS 路径解析值 vs 声明式期望值） | ✅ 已报出 |
| NC4 表头「前置任务」被改名 | sharedStrings：前置任务 → 前置任务表 | header-row（表头文本与列序） | header-row（表头文本与列序）、edge-equality（依赖边集合 vs 声明式期望边） | ✅ 已报出 |
| NC5 删掉第 29 行 | 移除该 <row> | field-equality（ExcelJS 路径解析值 vs 声明式期望值） | raw-cell-types（编码确实按声明落盘）、field-equality（ExcelJS 路径解析值 vs 声明式期望值）、edge-equality（依赖边集合 vs 声明式期望边） | ✅ 已报出 |

### 字段级差异（ExcelJS 路径解析值 vs 声明式期望值）

无差异。

### 依赖边差异（声明式期望边 vs 解析边）

- 期望边总数：16
- 缺失：无
- 多余：无

### 双路径差异（ExcelJS 对象层 vs zip 原始层）

无差异（逐格一致）。

### 结构化诊断（解析器输出）

无诊断输出。

### 日期列落盘形式分布

- 期望为空 × 14
- 数值序列号（yyyy-mm-dd） × 42

### 时区陷阱取证（同一个日历日期、不同构造方式）

判据：`exceljs/lib/utils/utils.js` 的 `dateToExcel(d) = 25569 + d.getTime() / 86400000`
——序列号由**绝对时刻**推导，因此用本地零点构造会得到带小数的序列号，
Excel 按序列号显示时落入**前一天**。

| 构造方式 | 落盘序列号 | 是否整数 | Excel 会显示的日期 | ExcelJS 读回的日期 |
|---|---|---|---|---|
| Date.UTC(y,m-1,d) | 46300 | 是（整数） | 2026-10-05 | 2026-10-05 |
| new Date(y,m-1,d) | 46299.66666666667 | **否（含小数）** | 2026-10-04 | 2026-10-04 |
| new Date('yyyy-mm-dd') | 46300 | 是（整数） | 2026-10-05 | 2026-10-05 |
| Date.UTC + 12h | 46300.5 | **否（含小数）** | 2026-10-05 | 2026-10-05 |

### 规范化产物的 zip 部件（第三方 diff 的基线）

| 部件 | 字节 | sha256（前 16） |
|---|---|---|
| `[Content_Types].xml` | 1264 | `0ee6278b34e013e9…` |
| `_rels/.rels` | 587 | `1285b20099c64699…` |
| `docProps/app.xml` | 803 | `b2357876bfe2c8e0…` |
| `docProps/core.xml` | 763 | `347d4ebb2f3548ec…` |
| `xl/_rels/workbook.xml.rels` | 697 | `db152538ca9d0a12…` |
| `xl/sharedStrings.xml` | 3006 | `471839c1f7d444c7…` |
| `xl/styles.xml` | 2176 | `233fa6127d586ed1…` |
| `xl/theme/theme1.xml` | 7961 | `f857ef82e4c0e273…` |
| `xl/workbook.xml` | 625 | `0b64571f9f04078d…` |
| `xl/worksheets/sheet1.xml` | 9307 | `55fb30526eb7471d…` |
