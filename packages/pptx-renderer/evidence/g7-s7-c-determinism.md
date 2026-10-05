# S7-c · PPTX 字节确定性实验

> **迁移说明**：本报告由 G7 准入探针 `spikes/g7-export-probe/src/s7-c-determinism.mjs` 生成
> （该探针目录随 G7 落地删除，证据原样迁到此处，正文不改写）。
> 由 `node src/s7-c-determinism.mjs` 生成（G7 准入实验 S-G7 的第三条门禁）。
> 判据：同一份输入连续两次导出的产物是否可逐字节比对；若否，不稳定项是否被归一化消除。

- 页面尺寸（容器实测 p:sldSz）：9144000 × 5143500 EMU（声明 9144000 × 5143500）
- `docProps/core.xml` 的 `dcterms:created`：A = 2026-10-05T09:47:43Z / B = 2026-10-05T09:47:45Z
- zip 条目 `ppt/slides/slide1.xml` 的日期：A = 2026-10-05T09:47:42.000Z / B = 2026-10-05T09:47:44.000Z
- 两次构建之间**显式跨过秒边界**（延迟 2.2 s）：否则"同秒内确定"是巧合而非性质
- 容器形状：bar-a#2、bar-b#3

| 阶段 | 两次产物逐字节相等 | 不稳定条目 |
|---|---|---|
| 容器（pptxgenjs 原始产物） | ❌ 不等 | [Content_Types].xml（仅时间戳不同）；_rels/.rels（仅时间戳不同）；docProps/app.xml（仅时间戳不同）；docProps/core.xml（内容不同）；ppt/_rels/presentation.xml.rels（仅时间戳不同）；ppt/notesMasters/_rels/notesMaster1.xml.rels（仅时间戳不同） …共 20 项 |
| 补丁后（未归一化） | ❌ 不等 | [Content_Types].xml（仅时间戳不同）；_rels/.rels（仅时间戳不同）；docProps/app.xml（仅时间戳不同）；docProps/core.xml（内容不同）；ppt/_rels/presentation.xml.rels（仅时间戳不同）；ppt/notesMasters/_rels/notesMaster1.xml.rels（仅时间戳不同） …共 19 项 |
| 归一化后（时间戳 + 条目日期固定） | ✅ 相等 | 无 |

## 逐条明细（不等时）

### 容器（pptxgenjs 原始产物）



| 条目 | 形态 | A | B |
|---|---|---|---|
| `[Content_Types].xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `_rels/.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `docProps/app.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `docProps/core.xml` | 内容不同 | b4009f828bdc | 29947bd9f9cf |
| `ppt/_rels/presentation.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesMasters/_rels/notesMaster1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesMasters/notesMaster1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesSlides/_rels/notesSlide1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesSlides/notesSlide1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/presProps.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/presentation.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideLayouts/_rels/slideLayout1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideLayouts/slideLayout1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideMasters/_rels/slideMaster1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideMasters/slideMaster1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slides/_rels/slide1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slides/slide1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/tableStyles.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/theme/theme1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/viewProps.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |

### 补丁后（未归一化）



| 条目 | 形态 | A | B |
|---|---|---|---|
| `[Content_Types].xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `_rels/.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `docProps/app.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `docProps/core.xml` | 内容不同 | b4009f828bdc | 29947bd9f9cf |
| `ppt/_rels/presentation.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesMasters/_rels/notesMaster1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesMasters/notesMaster1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesSlides/_rels/notesSlide1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/notesSlides/notesSlide1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/presProps.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/presentation.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideLayouts/_rels/slideLayout1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideLayouts/slideLayout1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideMasters/_rels/slideMaster1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slideMasters/slideMaster1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/slides/_rels/slide1.xml.rels` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/tableStyles.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/theme/theme1.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |
| `ppt/viewProps.xml` | 仅时间戳不同 | 2026-10-05T09:47:42.000Z | 2026-10-05T09:47:44.000Z |

### 归一化后（时间戳 + 条目日期固定）

逐字节相等，无不稳定项。

## 判定

- **归一化口径成立**：固定 `docProps/core.xml` 时间字段 + 固定全部 zip 条目日期后，两次产物**逐字节一致** ⇒ ADR 0010 §9 取**字节级 golden**。
