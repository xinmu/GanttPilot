# S2 · 第三方往返语义报告（wps-edit-save）

> 由 `node src/diff-variant.mts` 生成。**判据与 L1 相同**（复用 `verify-l1.ts` 的判定集），
> 因此「本报告通过」意味着同一套标准在第三方产物上仍然成立。

| 项 | 值 |
|---|---|
| 基线（我方规范化产物） | `out/canonical.xlsx` |
| 变体（第三方产物） | `out/wps-work/wps-edit-save.xlsx` |
| 语义字段差异 | 3 处 |
| 落盘单元格差异 | 44 处 |
| zip 部件差异 | 11 处 |
| 解析诊断 | 0 条 |
| **判定** | ✅ **通过**（语义等价，差异全部已声明） |

## 一、语义字段差异（基线解析值 → 变体解析值）

| WBS | 字段 | 基线 | 变体 | 是否已声明 |
|---|---|---|---|---|
| 2.1 | name | 渲染内核 | 渲染内核（已改名） | 是 |
| 2.1 | progress | 0.5 | 0.75 | 是 |
| 3.1 | start | 2026-10-05 | 2026-10-12 | 是 |





## 二、结构判据（与 L1 同一套；`field-equality` 因有意改动而单独看待）

| 检查 | 结果 | 实测 |
|---|---|---|
| `header-row（表头文本与列序）` | ✅ 通过 | 第 1 行：WBS \| 任务名称 \| 开始 \| 完成 \| 工期 \| 前置任务 \| 进度 \| 里程碑 \| 备注（共 9 格） |
| `raw-cell-types（编码确实按声明落盘）` | ✅ 通过 | 28 行的列类型与数字格式全部符合声明 |
| `dual-path（ExcelJS 对象层 vs zip 原始层逐格一致）` | ✅ 通过 | 214 格完全一致 |
| `edge-equality（依赖边集合 vs 声明式期望边）` | ✅ 通过 | 16 条边完全一致 |
| `raw-path-agreement（zip 路径解析值 vs ExcelJS 路径解析值）` | ✅ 通过 | 两条读取路径的解析结果逐字节相同 |
| `indent-not-semantic（清空缩进后解析结果不变）` | ✅ 通过 | 剔除缩进字段后，解析结果逐字节相同 |
| `indent-matches-depth（WBS 编号可独立推导层级）` | ✅ 通过 | 28 行的缩进与 WBS 深度一致 |
| `formula-prefix-text（= + - @ 前缀文本按字符串往返）` | ✅ 通过 | 4 行（5.2、5.3、5.4、5.5）逐字符一致且落盘为字符串 |
| `diagnostics-empty（结构化诊断为空）` | ✅ 通过 | 无诊断输出 |

## 三、日期列落盘形式

基线：数值序列号（yyyy-mm-dd） × 42

变体：数值序列号（yyyy\-mm\-dd） × 42

## 四、解析诊断

无诊断输出。

证据文件：`after-xl__worksheets__sheet1.xml`、`after-xl__workbook.xml`、`after-xl__styles.xml`、`after-xl__sharedStrings.xml`（`evidence\wps-edit-save` 下）。
