# xlsx 协议规范（G3）

> 本文件是 `@ganttpilot/xlsx-protocol` 的**权威说明**，供 G4（渲染/向导）、G5（编辑）、G7（导出物白名单复用）
> 与 G8（用户手册）共同引用。冻结口径见 [ADR 0006](../../docs/02-adr/0006-xlsx-协议契约.md)；
> 落地期的四条口径补齐见 [裁决 P-15](../../docs/00-baseline/裁决记录.md)；
> 能力块出口条件见 [首版能力顺序 G3](../../docs/01-roadmap/首版能力顺序.md)。
>
> **本包只交协议层纯函数**：字节流 ↔ 文档、列探测、结构化诊断。**不交任何 UI**（列映射向导、拖拽导入、
> 文件对话框都在 `apps/web`），**不接触 DOM**，**不渲染、不排版、不算排程**。
>
> **列身份的所有权自 G5 起不在本包**（[ADR 0008](../../docs/02-adr/0008-列身份所有权与拖拽交互契约.md) §1–§3）：
> `COLUMN_SPECS` / `ColumnKey` / `SHEET_NAME` / `HEADER_ROW` 等由 `@ganttpilot/render-core` 的
> `columns.ts` 唯一拥有，本包 `src/columns.ts` 只是**转型再导出**（公共 API 面一个符号不减，
> 因此本文档下方所有 `ColumnKey` 用法不变）。**列契约的内容（9 列的键、表头、必需性、列宽）
> 与 ADR 0006 §2 一字不改**，改的只是归属；改列集合请改 `render-core/src/columns.ts` 并同步本节。

## 一、四条铁律

1. **导出写「文档数据」，不写「排程结果」。** `Schedule` 永远是派生值（ADR 0004 §2）。
   "与甘特图一致"的判据是"导出 → 再导入后 `compute()` 逐字段深比较相等"，**不是**把 `es/ef` 写进文件
   （ADR 0006 §3 订正了 ADR 0004 §影响的原文表述）。
2. **日期一律 `Date.UTC(y, m-1, d)` 构造。** ExcelJS 的序列号公式是 `25569 + getTime()/86400000`
   ——序列号由**绝对时刻**推导，本地零点构造会写出带小数的序列号，Excel 显示**前一天**
   （本仓库已三次复现，S2 §三.4）。`dates.ts` 是唯一的构造点，代码里就地注释了原因。
3. **公式只读缓存值、扁平化、绝不解释。** 永不读公式文本、永不自研求值器、永不写公式回导出物
   （NG-06 / XL-08）。**"三类空"必须区分**：空单元格 / 公式无缓存值 / 公式被扁平化。
4. **容差是闭集。** 不在集合内的形态一律给诊断、**不做猜测**；诊断码表是闭集，
   不为新原因随手开码（需要时追加 ADR 并同步本文件）。

## 二、公共 API

```ts
type XlsxInput = Uint8Array | ArrayBuffer;   // 出参一律 Uint8Array；公共签名不出现 Buffer

function detectColumns(input: XlsxInput, options?: ImportOptions): Promise<ColumnDetectionResult>;
function importXlsx(input: XlsxInput, options?: ImportOptions): Promise<ImportResult>;
function importCsv(input: XlsxInput, options?: ImportOptions): Promise<ImportResult>;
function exportXlsx(document: ProjectDocument, options?: ExportOptions): Promise<ExportResult>;
function assembleReport(protocol, document?, schedule?): readonly ReportDiagnostic[];
```

**三个入口都是 `async`**（ADR 0006 §11 要求浏览器侧**动态 `import('exceljs')`**，把
925.5 KB min / 251.6 KB gzip 挡在首屏主 chunk 之外；`import()` 必然返回 Promise）。
Node 侧 ESM/CJS 互操作已实测可用：`import ExcelJS from 'exceljs'`（命名空间键只有 `default`，
**不能** `import { Workbook } from 'exceljs'`）。

```ts
interface ImportOptions {
  sheet?: string;                                      // 工作表名；缺省优先规范表 `任务`
  columns?: Partial<Record<ColumnKey, string | number>>; // 向导第 2 步：按表头文本或 1 基列号改绑
  calendar?: CalendarSpec;                              // 项目日历；缺省周一至周五、无例外
  projectName?: string;                                 // xlsx 里没有项目级字段
}

type ImportResult =
  | { ok: true;  document: ProjectDocument; diagnostics: readonly XlsxDiagnostic[] }
  | { ok: false;                 diagnostics: readonly XlsxDiagnostic[] };

type ExportResult =
  | { ok: true;  bytes: Uint8Array; diagnostics: readonly XlsxDiagnostic[] }
  | { ok: false;                    diagnostics: readonly XlsxDiagnostic[] };
```

**绝不抛异常报告用户级问题**：坏文件、缺列、脏单元格全部以结构化诊断返回
（异常控制流无法承载"逐条收集问题文案"，与 ADR 0003 §4 同一取舍）。

### 2.1 导入写库走命令层

`importXlsx` **只交文档**；把它写进应用状态**必须**经命令层的 `document.replace`
（唯一变更通道，ADR 0003 / ADR 0006 §7）。测试里的用法：

```ts
const imported = await importXlsx(bytes);
const applied = applyCommand(current, { kind: 'document.replace', document: imported.document });
```

## 三、列契约（规范工作表形态）

> **契约冻结在 [ADR 0006 §2](../../docs/02-adr/0006-xlsx-协议契约.md)**——规范工作表形态（单工作表 `任务`、无影子表、
> 首行表头、9 列的键与必需性）以那里为**唯一权威**；本节只登记**本包的实现面**：导出形态与匹配口径
> （单工作表、导出**固定 9 列列序**、导入**按列名匹配**、不要求列序相同）。下表是"键 → 导出形态"的对照，
> 与 ADR §2 的列集合**一字不改**。

| # | 表头 | 必需性 | 导出形态 | 语义 |
|---|---|---|---|---|
| 1 | `WBS` | **与缩进式二选一** | 文本 `1` / `1.2` / `1.2.3` | 层级来源；每段十进制整数、无前导零、段数 ≤ 20 |
| 2 | `任务名称` | **必需** | 文本，原样 | 任务名 |
| 3 | `开始` | 可选 | 真日期 + `yyyy-mm-dd` | `startDate`；空 = 缺失 |
| 4 | `完成` | 可选 | 同上 | `endDate`；**派生显示值**（工期为准） |
| 5 | `工期` | 可选 | 整数（工作日） | `durationDays`；空 = 缺失（不是 0） |
| 6 | `前置任务` | 可选 | `编号[FS\|SS\|FF\|SF][±lag]`，半角分号分隔 | 依赖边 |
| 7 | `进度` | 可选 | 数字 `0..1` + `0%` | 分数；空 = 未知（`null`，**不是 0**） |
| 8 | `里程碑` | 可选 | 布尔（`t="b"`） | `milestone`；空 = `false` |
| 9 | `备注` | 可选 | 文本，原样 | `notes`；空 = `null` |

- **不导出**：`id`、`parentId`、`collapsed`、`manual`、`constraints`、`baselines`、项目级字段
  （派生值 / 未启用语义 / 应用状态——**冻结口径见 ADR §2/§3**）；
- **空值 = 单元格缺失**（不写空串）；遇到空串视为"缺失"但给 `XLSX_INFERRED_EMPTY_CELL`(info)
  ——**容忍而不静默**；**汇总行可以没有日期与工期**（DM-05），协议层不下发"汇总行必须填什么"的规则。

### 3.1 表头定位与未识别列

- 表头行**按命中数打分**（命中规范列名最多的那一行；并列取最靠前），因此表头上方有标题/说明行也能正确落点；
- **多行表头**（规范列名分散在相邻两行）、**合并单元格表头**（跨列合并导致列名缺失）都会导致
  "没有任何一行能凑齐必需列" → `XLSX_REQUIRED_COLUMN_MISSING`(error)，**不猜**；
- **未识别的列**全部列出（`XLSX_UNRECOGNIZED_COLUMN`，warning），交向导第 2 步人工映射——
  两者都靠 `detectColumns()` 提供给向导。

## 四、单元格容差（闭集）

| 字段 | 导入必须接受 | 不接受的形态 → 诊断 |
|---|---|---|
| **日期** | ① 真日期（`Date`）② 数值序列号 ③ ISO 文本 `yyyy-mm-dd` ④ `yyyy/m/d`、`yyyy.m.d` | 空串/纯空白 → 缺失 + `XLSX_INFERRED_EMPTY_CELL`(info)；序列号 `< 1` 或不可表示 → `XLSX_DATE_OUT_OF_RANGE`(error)；**序列号非整数（带时刻）** → 取 UTC 日期部分 + `XLSX_DATE_HAS_TIME`(warning)；无法解析的文本 → `XLSX_DATE_UNPARSABLE`(warning) |
| **工期** | 数值；数值文本 | 小数 → `XLSX_DURATION_NOT_INTEGER`(error)，**不四舍五入**；负数 → `XLSX_DURATION_NEGATIVE`(error)；**`0` 合法**（里程碑）；空 = 缺失 |
| **进度** | 数字或数值文本，**`≤ 1` 视为分数、`> 1` 视为百分数**；`50%` 文本 | `< 0` 或 `> 100`（百分数口径）→ `XLSX_PROGRESS_OUT_OF_RANGE`(error)；非数值 → `XLSX_PROGRESS_UNPARSABLE`(warning) |
| **里程碑** | 布尔；`是`/`否`；`TRUE`/`FALSE`（大小写不敏感）；`1`/`0`（数值与文本） | 其它值 → `XLSX_MILESTONE_UNRECOGNIZED`(warning)，该任务取 `false` |
| **依赖** | 半角 `;` 与**全角 `；`**；类型可省（默认 `FS`）；**空片段容忍**（`1;;2`、结尾分号）；4 类关系；`±lag`；负 lag | 语法错 / 未知编号 → `XLSX_DEPENDENCY_UNPARSABLE`(warning)，**丢弃该条**；自环 → `XLSX_DEPENDENCY_SELF_LOOP`(warning)；重复边（同 from/to/type）→ `XLSX_DEPENDENCY_DUPLICATE`(warning)，只保留首条；端点为汇总任务 → 保留该边 + `XLSX_DEPENDENCY_SUMMARY_ENDPOINT`(warning) |
| **文本** | 原样字符串（含 `=`/`+`/`-`/`@` 前缀、emoji、超长文本，**不设长度上限、不转义**） | 与文档语义相关的前后空白 → `XLSX_TEXT_TRIMMED`(info)，**返回值仍原样**（trim 只用于判定） |

**两处必须写清的实现细节**（都踩过）：

1. **"带时刻"的判据只认序列号的小数部分**。真日期路径上的 `Date` 是序列号换算出的绝对时刻，
   它的时/分/秒反映的是**时区偏移**（UTC+8 下 `getHours()` 恒为 8），用它判定会把每个整日日期
   都误报成"带时刻"。因此 `XLSX_DATE_HAS_TIME` 只在**数值路径**上判定。
2. **日期读回用本地 getter**。ExcelJS 把序列号读成"绝对时刻"（`excelToDate`），
   在"写与读同一时区"的常态下，**本地** getter 读出的年月日恰好是用户看到的日历日。
   用 UTC getter 反而会在 UTC+8 的常见场景下差一天。已知边界：**跨时区**（写与读的偏移不同）时
   序列号对应的本地日历日可能偏移一天——这是"真日期 + 序列号"编码的固有属性，不是本实现的取舍，
   见 §九已知限制。

### 4.1 三方容器口径

ExcelJS 读回的单元格值有四类，归一化后都进同一套容差：

| 库里给的 | 归一化后 |
|---|---|
| `null` / `undefined` | `empty` |
| 标量（文本/数字/布尔/`Date`） | `text` / `number` / `boolean` / `date` |
| **公式对象** `{ formula, result }` | **单独处理**（§五），绝不落进"标量"分支 |
| `{ richText: [...] }` | 拍平成 `text`（富文本格式不保留） |
| `{ text, hyperlink }` | `text` |
| `{ error: '#DIV/0!' }` | `error`（按不可解析报） |

## 五、公式：只读缓存值，扁平化，绝不解释

> **口径与四条边界冻结在 [ADR 0006 §5](../../docs/02-adr/0006-xlsx-协议契约.md)**（只读缓存值、永不解释公式文本、
> 无缓存值按"值缺失"处理并给 `XLSX_FORMULA_WITHOUT_CACHED_VALUE`(info)、导出物只写值）——本节不重复登记。

**独立互证**（`tools/xlsx-reference/` 的差分即建立在这一致性上）：
openpyxl 3.1.5 在 `data_only=False` 下读出公式文本、`data_only=True` 下读出缓存值、
无缓存值时读出 `None`——与本条语义完全同构。

## 六、层级解析：双解析的优先级与冲突

> **优先级与冲突口径冻结在 [ADR 0006 §6](../../docs/02-adr/0006-xlsx-协议契约.md)**；下面是本包的**实现要点与码位**：

- **两条解析路径**：`WBS` 编号列（主）与**缩进式**（`alignment.indent` **仅作显示**）；
- 导入时：有 `WBS` 列 → 用编号解析；无 `WBS` 列 → 尝试缩进式；**两者都没有** →
  `XLSX_REQUIRED_COLUMN_MISSING`(error)（"二选一"的口径见 ADR §2）；
- **两者同时存在且结论不一致** → `XLSX_LEVEL_CONFLICT`(warning)，**以编号为准**并**记录冲突行**
  （不静默择一）；
- **冲突只比较"缩进确实承载了信息"的行**：`alignment.indent` 缺省为 0，若把 0 也当成
  "它声明这是顶层"，那么每个带 WBS 但没写缩进的文件都会被判成冲突——那不是冲突，
  那只是缩进这一路没信息。整列全 0 时**不做冲突判定**；
- **解析不得依赖缩进的具体数值**（只依赖相对深度），因为 WPS 会改写 `alignment.indent`；
- 层级结果照 ADR 0002 的规则产出：**全量重编号**（`reindexDocument()`），并保证
  "父节点先于子节点出现在文档序"。

### 6.1 编号 ↔ 任务 id 的口径

文档里的 `outlineNumber` 是**派生值**（真相源 = 层级 + 文档序，ADR 0002 ③），因此：

- 任务的 `id` 由**确定性序号**生成（顺序生成 `t1`/`t2`/…，不用全局自增——同一次导入必须逐次可复现）；
- **前置任务列按工作表里写的 WBS 编号解析**（那是用户认知的 `1.2`），解析顺序固定为
  **先按层级重编号 → 再用「工作表编号 ↔ 任务 id」映射解析依赖**；
- `links[].from/to` 是**任务 id**（ADR 0004 §4–§6 的冻结形状，`tools/cpm-reference` 的输入协议亦如此）。

## 七、导入问题清单与诊断码表（闭集）

**最终报告 = 三层诊断拼接，单一数组**：

| 层 | 来源 | 码空间 | 定位维度 |
|---|---|---|---|
| ① 协议层 | `importXlsx` / `detectColumns` | `XlsxDiagnosticCode`（本文件闭集） | `{sheet, row, column, address}` |
| ② 文档层 | `validateDocument(document)` | `DocumentDiagnosticCode`（ADR 0002） | `{path, taskId, linkId}` |
| ③ 排程层 | `compute(document, calendar)` | `ScheduleDiagnosticCode`（ADR 0004 §5） | `{taskId, linkId}` |

拼接用 `assembleReport()`：协议层在前（它是"文件的形状"），随后是文档层与排程层。
**协议层不合并、不重写另两层的码**。

| code | severity | 触发 |
|---|---|---|
| `XLSX_SHEET_NOT_FOUND` | error | 指定/期望的工作表不存在 |
| `XLSX_HEADER_ROW_INVALID` | error | 表头行无法识别（多行表头、合并单元格表头），或行级结构性错误（WBS 编号非法/缺失、文档校验失败） |
| `XLSX_REQUIRED_COLUMN_MISSING` | error | 必需列缺失（`任务名称`；`WBS` 与缩进式**同时**缺失） |
| `XLSX_UNRECOGNIZED_COLUMN` | warning | 列名未匹配到任何规范列（**列出全部**） |
| `XLSX_ROW_MISSING_NAME` | error | 行有其它内容但任务名为空 |
| `XLSX_DATE_UNPARSABLE` | warning | 日期单元格无法解析 |
| `XLSX_DATE_OUT_OF_RANGE` | error | 序列号 < 1（1900 年前）或超出可表示域 |
| `XLSX_DATE_HAS_TIME` | warning | 序列号非整数（带时刻），按 UTC 取日期部分 |
| `XLSX_DURATION_NOT_INTEGER` | error | 工期为小数 |
| `XLSX_DURATION_NEGATIVE` | error | 工期为负 |
| `XLSX_PROGRESS_UNPARSABLE` | warning | 进度非数值 |
| `XLSX_PROGRESS_OUT_OF_RANGE` | error | 进度小于 0 或大于 100（百分数口径） |
| `XLSX_MILESTONE_UNRECOGNIZED` | warning | 里程碑值不在容差集合内（取 `false`） |
| `XLSX_DEPENDENCY_UNPARSABLE` | warning | 依赖片段语法错或编号未知（丢弃该条） |
| `XLSX_DEPENDENCY_SELF_LOOP` | warning | 依赖指向自身 |
| `XLSX_DEPENDENCY_DUPLICATE` | warning | 同 from/to/type 重复（只保留首条） |
| `XLSX_DEPENDENCY_SUMMARY_ENDPOINT` | warning | 依赖端点为汇总任务（保留边；排程侧另有 `summaryIgnored`） |
| `XLSX_LEVEL_CONFLICT` | warning | 编号列与缩进式结论不一致（以编号为准） |
| `XLSX_CYCLE_EDGE_DROPPED` | warning | 成环边被丢弃（**消息里带成环路径**） |
| `XLSX_FORMULA_WITHOUT_CACHED_VALUE` | info | 公式无缓存值，按缺失处理 |
| `XLSX_INFERRED_EMPTY_CELL` | info | 空串/纯空白，按缺失处理 |
| `XLSX_TEXT_TRIMMED` | info | 首尾空白与文档语义相关（返回值仍原样） |

> **比 ADR 0006 §7 多一条**：`XLSX_TEXT_TRIMMED`。ADR 0006 §4 的文本行明确要求
> "与文档语义相关的前后空白 → `XLSX_TEXT_TRIMMED`(info)"，但 §7 的码表漏登了它。
> 这是**补充登记**（不是新开码），依据见 [裁决 P-15](../../docs/00-baseline/裁决记录.md)。

### 7.1 成环边丢弃（确定性，且不得用 `compute` 兜底）

- **排序口径**：解析出的**全部边按「工作表行序 × 单元格内前置出现顺序」**逐条处理；
- 对每条候选先调 `wouldCreateCycle(已接受的边, 候选)`：`cyclic === true` → **丢弃该条** +
  `XLSX_CYCLE_EDGE_DROPPED`（消息带 `path`）；否则接受；
- **丢弃的边不回插**（不做"删一条再试另一条"的回溯）；
- **理由**：`compute` 遇环时**整个失败**且失败结果的诊断面只有一条 `cycle`，
  所以"先 compute、失败再补救"这条捷径**不存在**；而丢弃顺序若不确定，
  "自往返一致"会变成偶发失败。

## 八、CSV：尽力导入（XL-07）

> **"尽力导入"的边界（接受什么、不支持什么）冻结在 [ADR 0006 §9](../../docs/02-adr/0006-xlsx-协议契约.md)**；
> 下面是本包的实现要点。

- 接受：逗号分隔、可选双引号包裹（`""` 表示字面量引号）、**UTF-8（含 BOM）**、首行表头；
  **不支持**（明确诊断而非错误解析）：多行单元格、分隔符嗅探、`.xls`(BIFF)——**这条边界冻结在 [ADR 0006 §9](../../docs/02-adr/0006-xlsx-协议契约.md)**；
- `importCsv` **复用同一套列契约、容差表与诊断码表**（不另立第二套规则）；
- `importXlsx` 也接受 CSV：按**字节形态**识别（xlsx 是 zip，前两字节必为 `PK`；否则按文本处理）；
- **导出 CSV 不在 v0.1 承诺内**（D-2）。若日后实现，**必须**做公式注入转义
  （`=`/`+`/`-`/`@` 前缀）——这与 xlsx 路径的豁免**不同源**：CSV 没有"共享字符串"这层保护；
- UTF-8 解码是**手写**的（不用 `TextDecoder`：三包的 `tsconfig` 收窄了 `lib`，没有 Web API 声明）。

## 九、导出物的形式与确定性

> **导出物的形式与白名单冻结在 [ADR 0006 §10](../../docs/02-adr/0006-xlsx-协议契约.md)**（单工作表、9 列列序、
> 规范日期与依赖语法、呈现属性白名单与禁止项）；本节只登记本包的**实现与确定性判据**。

- **固定文档时间戳**：`created` / `modified` / `creator` / `lastModifiedBy` **取常量**
  （`FIXED_DOCUMENT_TIMESTAMP` = `2000-01-01T00:00:00Z`），**不得**来自当前时间——
  否则每次导出的部件内容都不同；
- **确定性判据**（口径冻结在 [ADR 0006 §10](../../docs/02-adr/0006-xlsx-协议契约.md)：取**部件指纹**、不得用整文件哈希）：
  本包持有的是**反向证据**——同进程连跑两次的整文件哈希**可能相同也可能不同**，
  正因为它取决于"写入时刻落在哪一秒"，它就不是判据；
- **呈现属性的结构断言纪律**（白名单与禁止项见 ADR §10）：**每加一类呈现属性必须补一条结构断言**
  ——历史上"需要修复"的提示多来自这一类别；
- **导出失败的条件**：文档里有任务名为空（schema 要求非空但校验只给 warning），或
  `validateDocument` 有 error 级诊断——这两种情况下**不产出字节**，
  避免"写出一份自己都读不回来的文件"；
- **导出不含依赖环的边**：文档里有环时，前置列**省略**该边并报 `XLSX_CYCLE_EDGE_DROPPED`
  （保证导出物可重新导入）。

**不导出的字段**：`id`/`parentId`/`collapsed`/`manual`/`constraints`/`baselines`/项目级字段/
日历例外 —— 因此"项目名与日历例外不往返"是**刻意的口径**，不是缺陷：`exceptions` 的工作表表达归 v0.5
（R-1），项目名在 v0.1 由应用层维护。这条差异有专门的用例显式断言（不靠"碰巧相等"）。

### 9.1 已知限制（必须与结论一起读）

- **跨时区读同一文件**时，真日期（序列号）对应的本地日历日可能偏移一天——这是"真日期 + 序列号"
  编码的固有属性（Excel 的序列号语义就是"本地墙钟"），不是本实现的取舍；
- **Microsoft Excel / Google Sheets 往返不作承诺**（与裁决 P-4/P-5 同口径，**不进入 G3 出口条件**）；
- **不保留用户的列顺序 / 样式 / 公式**（T-2：导出即规范化）。

## 十、依赖与捆绑

- **ExcelJS 是运行时依赖**（`dependencies`，精确钉 `4.4.0`）：升级必须重跑
  确定性（部件指纹）、日期序列号整数性、格式码解析三项证据；
- **浏览器侧必须动态导入**（`import('exceljs')`）：`dist/exceljs.min.js` 实测
  **925.5 KB min**（`.bare.min.js` 842 KB）、包内**无 ESM 入口**、**不可 tree-shaking**。
  本块**不设 chunk 体积门禁**（首屏预算是 G4 的指标），只**记录实测体积**；
- **"零 DOM 依赖"不因本依赖而放宽**：铁律约束的是**我们的源码**；依赖内部存在
  `document.*`/`window.*` 探测代码，我们不调用它的 DOM 分支——这条差异在此显式记录；
- **传递依赖的一处抬高**：`exceljs@4.4.0` 声明的 `unzipper@^0.10.11` 会拖入一棵
  **未声明许可**的子树（`unzipper@0.10.x → fstream/binary → buffers@0.1.1`，
  其 `package.json` 的 `license` 字段为空、上游仓库已不可达）。`pnpm-workspace.yaml` 的
  `overrides` 把它抬到 **`unzipper@0.12.5`（MIT）**，该版本已不再依赖那三个包，
  于是 `pnpm license:check` 能在**不新增白名单豁免**的前提下通过。
  代价：`exceljs` 的读路径走的是 `unzip.Parse({forceStream: true})`，**已实测**在该版本下
  读写全链路可用（依据与代价见裁决 P-15）。

## 十一、模板文件（多页签形态；G8／[P-46（依据）](../../docs/00-baseline/裁决R45.md)）

> 本节是 [ADR 0006 附录 §1（细则）](../../docs/02-adr/附录/0006-增补.md) 的**落地形态**：
> 它是**一个新的导出物形态**，登记义务已在附录兑现（§2 的"单工作表"约束的是**规范表的读入口径**，
> 不是"一个文件里不许有别的页签"）。

```ts
function buildTemplateXlsx(document?: ProjectDocument): Promise<TemplateResult>;   // 缺省 = 演示计划
function templateSheetNames(): readonly string[];                                  // ['任务','填写说明与约束','最小示例']
```

### 11.1 结构（**冻结**）

| # | 页签 | 内容 |
|---|---|---|
| ① | `任务` | **规范 9 列**（列序、表头、必需性同 §三），**可直接被 `importXlsx` 读入**；示例行取 `demoPlan.ts` 的 15 行 |
| ② | `填写说明与约束` | 列语义、4 类依赖语法、三类"空"的区别、**常见错误 ↔ 诊断码**（§七 的既有码表） |
| ③ | `最小示例` | 同一份演示计划的 9 列文本（给人看，不参与导入） |

- **不设隐藏表**（§三/§九 的白名单）；呈现属性只用白名单四类（表头加粗 / 列宽 / 数字格式 / 冻结首行）；
- **`任务` 页的生成方式是"搬运 `exportXlsx` 的产物"**，不是在本模块里重写表头/列序/依赖文本——
  否则列契约就出现第二份真相源（"模板与协议随时对齐"是本条的验收目标）；
- **不新增诊断码**：模板走的是**导入**路径，形态问题由既有码表覆盖（缺列 = `XLSX_REQUIRED_COLUMN_MISSING` 等）；
- **仓库内不放 `.xlsx` 二进制**：模板**运行时生成**，避免"二进制与协议分叉"。

### 11.2 判据

| 层 | 判据 |
|---|---|
| 门禁（`template.spec.ts`，**6 例**） | ① 页签**集合与顺序**（恰好三个）；② `任务` 页 9 列列序与表头与 `COLUMN_SPECS` 逐值一致；③ **两次生成逐字节一致**（固定时间戳）；④ **可读回**（任务数一致、**error 0**、文档校验无 error）；⑤ 说明页覆盖四类依赖与关键诊断码；⑥ **负向对照**（调换页签顺序 / 改一个表头字面必须被检出） |
| 打包产物（`smoke:build`） | 点「模板下载」→ **文件真的落盘** → 解出三个页签 → **用应用自己的导入入口回导** ⇒ 计数合理、无"导入失败"、无应用级错误（在线与 `file://` 两种产物都跑） |

**实测**：模板 **11,668 字节**；两次生成逐字节一致；回导后 **15 任务 / 14 依赖 / 0 条 error**。

> **一条影响"按 id 挑任务"的事实**：xlsx **不承载任务 id**（§三 的 9 列里没有 `id`），
> 导入时 id 由**行序**生成 ⇒ "导出 → 再导入"之后 **id 与原来不同**（身份是 `WBS` 编号）。
> 记录制/冒烟脚本必须按**语义**挑任务（例如"非汇总 + 有条形 + 开始列非空"），不能按 id 挑。

## 十二、验证与门禁（六层证据）

| 层 | 手段 | 位置 | 判据 |
|---|---|---|---|
| ① 声明式期望值 | 列契约 / 容差表 / 依赖语法 / 诊断码的逐条用例（**内核无权改基准**，同 `schedule.manual.spec.ts` 的手法） | `xlsxExpectations.spec.ts` / `xlsxDependencies.spec.ts` | 逐条相等；**末附负向对照**（打坏期望值必须变红） |
| ② 自往返幂等 | 导出 → 导入 → 文档深比较 + `compute` 深比较 | `xlsxRoundTrip.spec.ts` | 逐项相等（含"日期为 null 的节点"与"字段留位"） |
| ③ 跨语言差分 | JS 协议 ↔ **openpyxl**（纯独立实现，只共享字段契约） | `xlsx.differential.spec.ts` + [`tools/xlsx-reference/`](../../tools/xlsx-reference/README.md) | **双向**逐字段一致；**缺 Python 3 或缺 openpyxl 即失败** |
| ④ 负向对照 | S2 §三.1 的 5 条字节变造（改类型 / 改序列号 / 改进度 / 改表头 / 删行） | `xlsxNegativeControls.spec.ts` | 全部被判定集报出 |
| ⑤ 结构哨兵 | LibreOffice headless 打开导出物 | `xlsxPerformance.spec.ts` | **哨兵 ≠ 门禁**（裁决 P-9）；本机不可用时记录"未运行"并跳过 |
| ⑥ 性能与体积 | 200 行端到端（字节 → `compute`）与 ExcelJS 浏览器入口体积 | `xlsxPerformance.spec.ts` | **只记录实测，不设硬阈值**；对照"≤3 秒"给出数值 |

**实测（Windows，Node 26.7.0，本机）**：

| 口径 | 实测 |
|---|---|
| 200 行端到端（`bytes → importXlsx → createScheduleCalendar → compute`） | 中位 **12.6 ms**（最慢 43.7 ms）⇒ 对"≤3 秒"约 **238×** 余量 |
| 其中 `importXlsx` | 中位 **8.8 ms** |
| 其中 `compute` | 中位 **0.56 ms** |
| 200 行导出物 | 14,707 字节 / **10 个部件** |
| `exceljs` 浏览器入口 | `dist/exceljs.min.js` = **925 KB**、`exceljs.bare.min.js` = 842 KB |
| 部件指纹确定性 | 同一文档两次导出**部件内容逐字节相同** |
| LibreOffice 结构哨兵 | 本机 **未找到 `soffice`** ⇒ 记录"未运行"并跳过（不是通过） |

## 十三、明确不做（本块边界）

| 项 | 归属 |
|---|---|
| 公式 / 条件格式 / 宏的解释（一律扁平化为值，且只读缓存值） | **永久非目标**（NG-06 / XL-08） |
| `.xls`(BIFF) 读取（ExcelJS 不支持） | **v0.5+**（README 已知限制） |
| 影子表 `__gantt_meta__` | 不做（T-2 已删除） |
| 保留用户原有列顺序 / 样式 / 公式 | **不做**（T-2：导出即规范化） |
| CSV 无损、CSV 导出 | v0.5（D-2） |
| Microsoft Excel / Google Sheets 往返承诺 | 不做承诺（P-4 / P-5） |
| 列映射向导、拖拽导入、文件对话框 | **G4/G5**（`apps/web`）；本块只交 `detectColumns` |
| 渲染、排程、`Schedule` 的展示 | G4 / G2 |
| 多日历、日历例外的工作表表达 | **v0.5**（R-1） |
| 2,000 任务规模压测 | v0.5（D-2） |
| 模板的**静态文件分发**（仓库内放一份 `.xlsx`） | **不做**（[P-46 §5（依据）](../../docs/00-baseline/裁决R45.md)：运行时生成，避免"二进制与协议分叉"） |
| 模板的页签**超过三个**、模板内嵌日历例外说明 | v0.5 视反馈再定 |
