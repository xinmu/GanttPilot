# `tools/xlsx-reference`：xlsx 协议的独立参照实现

> **这不是移植，是"另一种写法"。** 它与 `packages/xlsx-protocol` 只共享
> [ADR 0006 §2/§4/§7](../../docs/02-adr/0006-xlsx-协议契约.md) 声明的**字段与容差契约**，
> 不共享任何一行代码：实现（openpyxl vs ExcelJS）、容器读写（openpyxl 自己处理 zip/XML）、
> 单元格承载（`datetime` vs `Date`/序列号）全部不同。
> 依据见 [ADR 0006 §12](../../docs/02-adr/0006-xlsx-协议契约.md) 第 ③ 层与
> [裁决 P-14](../../docs/00-baseline/裁决记录.md) 第 1 条（验证层四件套）。
>
> **它为什么不在 `packages/xlsx-protocol` 里**：三包（engine / xlsx-protocol / pptx-renderer）
> **不放非 TS 资产**。差分本体在 `packages/xlsx-protocol/src/xlsx.differential.spec.ts`，
> 因此**差分就在 `pnpm gate` 的 `test` 步骤里真实运行**——**缺 Python 3 或缺 openpyxl 时该步失败，
> 而不是静默跳过**（与 [`tools/cpm-reference`](../cpm-reference/README.md) 同一口径）。

## 一、用法

```bash
python tools/xlsx-reference/xlsx_reference.py <工作目录>
```

- 解释器解析由调用方（TS 侧）负责：`GANTTPILOT_PYTHON` → `python` → `python3` → `py -3`，
  并**先用 `<解释器> --version` 探测可用性**（`stdio: 'ignore'`，不走管道）；
- Windows 上 `python` 常是 `.bat` 垫片，`spawnSync` 直接执行会得到**退出码 9009**（不是 `ENOENT`），
  TS 侧会退回到 `cmd.exe /d /s /c` 执行——这不是脚本失败；
- 退出码：0 = 成功；2 = 参数个数不对；3 = **缺 openpyxl**（必须显式失败，不静默跳过）；
- 依赖口径：**`openpyxl==3.1.5`**（ADR 0006 §12 与裁决 P-14 的 E10 实测版本）。

## 二、产出（全部 UTF-8，末尾换行）

| 文件 | 内容 |
|---|---|
| `py-fixture.xlsx` | openpyxl 亲手写出的 fixture（**编码形态刻意与 JS 导出不同**） |
| `py-read-report.json` | openpyxl 读 `py-fixture.xlsx` 的**逐格事实** + 按容差表独立推导出的文档语义 |
| `js-export.xlsx` | 由差分 spec 先落盘的 G3 导出物（本脚本只读它） |
| `js-read-report.json` | openpyxl 读 `js-export.xlsx` 的逐格事实 + 独立推导 |

> **控制台码页会把中文打成乱码**（本机实测）：一切结果都写文件，stdout 只输出人读的摘要。
> 靠 stdout 比对会得到**假失败**。

## 三、两个方向（缺一不可）

| 方向 | 谁写 | 谁读 | 比什么 |
|---|---|---|---|
| **A** | openpyxl | JS 的 `importXlsx` | JS 导入出的**文档** vs 参照实现独立推导出的语义 |
| **B** | JS 的 `exportXlsx` | openpyxl | openpyxl 读到的**逐格事实** vs 声明式期望值 |

方向 A 的 fixture **故意与 JS 导出物用不同的编码形态**，这样这一层才真的在验"容差闭集"：

| 字段 | 方向 A（Python 写） | 方向 B（JS 写） |
|---|---|---|
| 日期 | ISO 文本 / 斜杠文本 / **裸序列号** 三种混写 | 真日期（整数序列号）+ `yyyy-mm-dd` |
| 进度 | 百分数点位（`50`）/ 百分号文本（`75%`）/ 分数（`0.25`） | 分数 + `0%` |
| 里程碑 | `是` / `TRUE` / 布尔 `true` | 布尔 |
| 依赖 | **全角分号** `；`、省略类型、负 lag | 半角分号 `;` |
| 公式 | 有缓存值 / 无缓存值（两通道互证） | 只写值（永不写公式） |

## 四、公式为什么能"两通道互证"

openpyxl 3.1.5 与 ExcelJS 在这一点上**语义同构**（裁决 P-14 的 E8 已实测）：

| | 公式文本 | 缓存值 | 无缓存值 |
|---|---|---|---|
| ExcelJS | `{ formula, result }` | `result` | `result: undefined` |
| openpyxl（`data_only=False`） | `'=A1'` | 同上 | 同上 |
| openpyxl（`data_only=True`） | —— | 值 | **`None`**（与空单元格同形） |

因此"公式有缓存值 / 公式无缓存值 / 本来就是空"这三类在两侧**可区分**，差分才比得出东西。
本脚本用 `patch_formula_cache()` 给公式单元格补 `<v>`（openpyxl 自己不计算）；
实测 openpyxl 落盘的是 `<c r="C10"><f>A1</f><v /></c>`（**自闭合的空 `<v>`**），
所以正则必须同时容忍"没有 `<v>`"与"空的 `<v />`"两种形态。

## 五、工程约束

- 只用标准库 `json` / `re` / `sys` / `zipfile` / `datetime` + openpyxl；
- **不引入第三方 xlsx 写出器**（XlsxWriter 不用于本脚本：它只能写，不能读，差分的价值在"读"）；
- 输出确定性：同一输入 → 逐字节相同的 JSON（键排序，`sort_keys=True`）；
- 控制台输出切 UTF-8（Windows 默认 GBK 会把中文日志打成乱码）。
