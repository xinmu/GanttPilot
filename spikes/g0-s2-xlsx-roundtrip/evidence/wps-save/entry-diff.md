# S2 · 部件级差异（wps-save）

> 「第三方到底重写了什么」——`sha256` 未变即未触碰；被重写的部件可用同目录下的
`before-*.xml` 与 `after-*.xml` 直接 diff。

| 部件 | 结果 | 基线字节 | 变体字节 | 摘要 |
|---|---|---|---|---|
| `[Content_Types].xml` | **重写** | 1264 | 1293 | `0ee6278b…` → `5cbe88e823766fa0…` |
| `_rels/.rels` | **重写** | 587 | 735 | `1285b200…` → `9f3d3fa493e6b805…` |
| `docProps/app.xml` | **重写** | 803 | 569 | `b2357876…` → `71dc7faf15f7c741…` |
| `docProps/core.xml` | **重写** | 763 | 618 | `347d4ebb…` → （含时间戳，哈希每次不同，不比较） |
| `docProps/custom.xml` | 新增 | — | 644 | （含时间戳，哈希每次不同，不比较） |
| `xl/_rels/workbook.xml.rels` | **重写** | 697 | 698 | `db152538…` → `7ab482ecf88f17db…` |
| `xl/sharedStrings.xml` | **重写** | 3006 | 3007 | `471839c1…` → `bd7e37806d6c9ce2…` |
| `xl/styles.xml` | **重写** | 2176 | 20577 | `233fa612…` → `4604e7e59881b6a0…` |
| `xl/theme/theme1.xml` | **重写** | 7961 | 7624 | `f857ef82…` → `24a7dffe1d478508…` |
| `xl/workbook.xml` | **重写** | 625 | 1480 | `0b64571f…` → `aa0d236b29cd1961…` |
| `xl/worksheets/sheet1.xml` | **重写** | 9307 | 8723 | `55fb3052…` → `21f3f937485a3514…` |

## 落盘单元格差异（前 60 条）

| 单元格 | 基线 | 变体 |
|---|---|---|
| C11 | number=46300｜numFmt=yyyy-mm-dd｜style=5 | number=46300｜numFmt=yyyy\-mm\-dd｜style=5 |
| C12 | number=46307｜numFmt=yyyy-mm-dd｜style=5 | number=46307｜numFmt=yyyy\-mm\-dd｜style=5 |
| C13 | number=46308｜numFmt=yyyy-mm-dd｜style=5 | number=46308｜numFmt=yyyy\-mm\-dd｜style=5 |
| C14 | number=46318｜numFmt=yyyy-mm-dd｜style=5 | number=46318｜numFmt=yyyy\-mm\-dd｜style=5 |
| C16 | number=46318｜numFmt=yyyy-mm-dd｜style=5 | number=46318｜numFmt=yyyy\-mm\-dd｜style=5 |
| C17 | number=46322｜numFmt=yyyy-mm-dd｜style=5 | number=46322｜numFmt=yyyy\-mm\-dd｜style=5 |
| C18 | number=46330｜numFmt=yyyy-mm-dd｜style=5 | number=46330｜numFmt=yyyy\-mm\-dd｜style=5 |
| C19 | number=46331｜numFmt=yyyy-mm-dd｜style=5 | number=46331｜numFmt=yyyy\-mm\-dd｜style=5 |
| C22 | number=46335｜numFmt=yyyy-mm-dd｜style=5 | number=46335｜numFmt=yyyy\-mm\-dd｜style=5 |
| C23 | number=46336｜numFmt=yyyy-mm-dd｜style=5 | number=46336｜numFmt=yyyy\-mm\-dd｜style=5 |
| C24 | number=46337｜numFmt=yyyy-mm-dd｜style=5 | number=46337｜numFmt=yyyy\-mm\-dd｜style=5 |
| C25 | number=46338｜numFmt=yyyy-mm-dd｜style=5 | number=46338｜numFmt=yyyy\-mm\-dd｜style=5 |
| C26 | number=46339｜numFmt=yyyy-mm-dd｜style=5 | number=46339｜numFmt=yyyy\-mm\-dd｜style=5 |
| C27 | number=46342｜numFmt=yyyy-mm-dd｜style=5 | number=46342｜numFmt=yyyy\-mm\-dd｜style=5 |
| C28 | number=46343｜numFmt=yyyy-mm-dd｜style=5 | number=46343｜numFmt=yyyy\-mm\-dd｜style=5 |
| C29 | number=46344｜numFmt=yyyy-mm-dd｜style=5 | number=46344｜numFmt=yyyy\-mm\-dd｜style=5 |
| C3 | number=46300｜numFmt=yyyy-mm-dd｜style=5 | number=46300｜numFmt=yyyy\-mm\-dd｜style=5 |
| C4 | number=46303｜numFmt=yyyy-mm-dd｜style=5 | number=46303｜numFmt=yyyy\-mm\-dd｜style=5 |
| C6 | number=46304｜numFmt=yyyy-mm-dd｜style=5 | number=46304｜numFmt=yyyy\-mm\-dd｜style=5 |
| C7 | number=46304｜numFmt=yyyy-mm-dd｜style=5 | number=46304｜numFmt=yyyy\-mm\-dd｜style=5 |
| C8 | number=46310｜numFmt=yyyy-mm-dd｜style=5 | number=46310｜numFmt=yyyy\-mm\-dd｜style=5 |
| D11 | number=46304｜numFmt=yyyy-mm-dd｜style=5 | number=46304｜numFmt=yyyy\-mm\-dd｜style=5 |
| D12 | number=46315｜numFmt=yyyy-mm-dd｜style=5 | number=46315｜numFmt=yyyy\-mm\-dd｜style=5 |
| D13 | number=46309｜numFmt=yyyy-mm-dd｜style=5 | number=46309｜numFmt=yyyy\-mm\-dd｜style=5 |
| D14 | number=46318｜numFmt=yyyy-mm-dd｜style=5 | number=46318｜numFmt=yyyy\-mm\-dd｜style=5 |
| D16 | number=46323｜numFmt=yyyy-mm-dd｜style=5 | number=46323｜numFmt=yyyy\-mm\-dd｜style=5 |
| D17 | number=46329｜numFmt=yyyy-mm-dd｜style=5 | number=46329｜numFmt=yyyy\-mm\-dd｜style=5 |
| D18 | number=46330｜numFmt=yyyy-mm-dd｜style=5 | number=46330｜numFmt=yyyy\-mm\-dd｜style=5 |
| D19 | number=46332｜numFmt=yyyy-mm-dd｜style=5 | number=46332｜numFmt=yyyy\-mm\-dd｜style=5 |
| D22 | number=46335｜numFmt=yyyy-mm-dd｜style=5 | number=46335｜numFmt=yyyy\-mm\-dd｜style=5 |
| D23 | number=46336｜numFmt=yyyy-mm-dd｜style=5 | number=46336｜numFmt=yyyy\-mm\-dd｜style=5 |
| D24 | number=46337｜numFmt=yyyy-mm-dd｜style=5 | number=46337｜numFmt=yyyy\-mm\-dd｜style=5 |
| D25 | number=46338｜numFmt=yyyy-mm-dd｜style=5 | number=46338｜numFmt=yyyy\-mm\-dd｜style=5 |
| D26 | number=46339｜numFmt=yyyy-mm-dd｜style=5 | number=46339｜numFmt=yyyy\-mm\-dd｜style=5 |
| D27 | number=46342｜numFmt=yyyy-mm-dd｜style=5 | number=46342｜numFmt=yyyy\-mm\-dd｜style=5 |
| D28 | number=46343｜numFmt=yyyy-mm-dd｜style=5 | number=46343｜numFmt=yyyy\-mm\-dd｜style=5 |
| D29 | number=46344｜numFmt=yyyy-mm-dd｜style=5 | number=46344｜numFmt=yyyy\-mm\-dd｜style=5 |
| D3 | number=46302｜numFmt=yyyy-mm-dd｜style=5 | number=46302｜numFmt=yyyy\-mm\-dd｜style=5 |
| D4 | number=46303｜numFmt=yyyy-mm-dd｜style=5 | number=46303｜numFmt=yyyy\-mm\-dd｜style=5 |
| D6 | number=46317｜numFmt=yyyy-mm-dd｜style=5 | number=46317｜numFmt=yyyy\-mm\-dd｜style=5 |
| D7 | number=46309｜numFmt=yyyy-mm-dd｜style=5 | number=46309｜numFmt=yyyy\-mm\-dd｜style=5 |
| D8 | number=46317｜numFmt=yyyy-mm-dd｜style=5 | number=46317｜numFmt=yyyy\-mm\-dd｜style=5 |


