# 文档 schema 规范（G1.2）

> 本文件是 `@ganttpilot/engine` 文档模型（`packages/engine/src/schema.ts`、`wbs.ts`）的**权威说明**，
> 供 G3（xlsx 导入/导出）、G4（渲染）、G6（持久化）与 G5（编辑）共同引用。
> 决策依据与取舍见 [ADR 0002](../../docs/02-adr/0002-文档模型与序列化契约.md)；
> 能力块出口条件见 [首版能力顺序 G1.2](../../docs/01-roadmap/首版能力顺序.md)。
> **变更通道**（命令层、before 镜像、事务与撤销/重做）见 [COMMAND.md](COMMAND.md)——本文件只描述形状；
> 命令层保证其产出必然满足本规范（它直接复用 `validateDocument`，不复制规则）。

## 一、三条铁律

1. **落盘用 ISO 日期 + 工作日工期，工作日序号只出现在引擎入参边界。**
   文档里的 `2025-01-06` 是「项目时区的日期」，`durationDays: 4` 是「4 个工作日」；
   只有喂给 `Calendar` 时才翻译成整数序号。理由：避免文档被日历地平线容量绑定
   （依据 [S3 结论 §八 A.1/C.11](../../spikes/g0-s3-cpm-perf/结论.md)、裁决 P-10 第 4 条）。
2. **`null` 表示"缺失"，且序列化始终显式写出全部规范字段。**
   于是「序列化 → 解析」可以用深比较（`toStrictEqual`）判定往返一致，不必先归一化。
   反序列化同时容忍"缺键"（归一为 `null`）但会产出 `info` 级诊断（`DOC_FIELD_OMITTED`）——
   **容忍而不静默**。
3. **`outlineNumber` 是派生值，不是真相源。**
   真相源是「层级（`parentId`） + 文档序（`tasks[]` 的出现顺序）」；
   编号只是它的像。校验对不一致报 `TREE_OUTLINE_STALE`，修复动作是 `reindexDocument()`。
   **校验只读，从不改写文档。**

## 二、规范形状

```jsonc
{
  "version": 3,
  "project": {
    "name": "项目名",
    "description": null,
    "baseCalendarId": "project",
    "startDate": "2025-01-01",
    "finishDate": null
  },
  "calendars": [
    {
      "id": "project",
      "exceptions": { "nonWorking": ["2026-10-12"], "working": ["2026-10-17"] }
    }
  ],
  "tasks": [
    {
      "id": "t1",
      "parentId": null,
      "outlineNumber": "1",
      "name": "阶段一",
      "startDate": "2025-01-06",
      "endDate": "2025-01-10",
      "durationDays": 4,
      "progress": 0.5,
      "milestone": false,
      "collapsed": false,
      "notes": null,
      "manual": false,
      "constraints": []
    }
  ],
  "links": [{ "id": "l1", "from": "t1", "to": "t2", "type": "FS", "lagDays": 0 }],
  "baselines": []
}
```

### 2.1 字段语义

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `version` | 整数 | schema 版本。当前 `3`；支持区间 `1..3`（见 §四） |
| `project.name` | 字符串 | 项目名（可为空串） |
| `project.description` | 字符串 \| `null` | 项目说明 |
| `project.baseCalendarId` | 字符串 | **v0.1 唯一生效的日历**（R-1）；必须存在于 `calendars[]` |
| `project.startDate` / `finishDate` | ISO 日期 \| `null` | `startDate` = **排程的项目起点基准**（[ADR 0004](../../docs/02-adr/0004-排程契约.md) §4：非空则取它，否则回落锚点最小值）；`finishDate` 仍是文档级留位（G7 摘要可读）。本块只校验格式 |
| `calendars[].id` | 字符串 | 日历标识；缺省 `'project'` |
| `calendars[].workDays` | 整数数组 | `0=周日 … 6=周六`。**省略 = 用默认周一至周五**；空数组是"没有任何工作日"，**非法** |
| `calendars[].exceptions` | 对象 | `nonWorking`（工作日→非工作日）与 `working`（休息日→工作日）两个 ISO 日期数组；**同日冲突时非工作日优先**（DM-06） |
| `tasks[].id` | 非空字符串 | 文档内唯一 |
| `tasks[].parentId` | 字符串 \| `null` | `null` = 顶层；必须指向存在的任务 |
| `tasks[].outlineNumber` | 字符串 | 派生值，形如 `1` / `1.2` / `1.2.3`；**段数 ≤ 20**（`MAX_OUTLINE_DEPTH`） |
| `tasks[].name` | 字符串 | 任务名 |
| `tasks[].startDate` / `endDate` | ISO 日期 \| `null` | **可空**（DM-05）。两者都给时 `endDate` 不得早于 `startDate` |
| `tasks[].durationDays` | 整数 \| `null` | **工作日**，`0..1_000_000`；不可为负 |
| `tasks[].progress` | 数字 \| `null` | `[0, 1]` 的**分数**；`null` = 未知 |
| `tasks[].milestone` | 布尔 | 里程碑标记 |
| `tasks[].collapsed` | 布尔 | 折叠状态（DM-01）；**只有状态，渲染行为归 G4** |
| `tasks[].notes` | 字符串 \| `null` | 备注 |
| `tasks[].manual` | 布尔 | **字段留位、语义未启用**（DM-09 → v0.5） |
| `tasks[].constraints` | 对象数组 | **字段留位、语义未启用**（DM-08 → v0.5）。本块只校验"JSON 对象数组" |
| `links[].id` | 非空字符串 | 文档内唯一 |
| `links[].from` / `to` | 非空字符串 | 必须指向存在的任务，不得自环 |
| `links[].type` | `FS`\|`SS`\|`FF`\|`SF` | 4 类关系（DM-03）。省略按 `FS` |
| `links[].lagDays` | 整数 | **工作日**，可为负（lead），`±100_000` 以内（R-1） |
| `baselines[].id` / `name` / `createdAt` | 字符串 | 基线留位（P1-03）；`createdAt` 必须可被 `Date.parse` 解析 |
| `baselines[].snapshot` | 任意 JSON 值 | **不透明**：本块只校验"是 JSON 值"，内容 v0.5 定义 |

### 2.2 一处刻意的不对称：`workDays` 省略 vs `exceptions` 显式

- `workDays` **为空数组时省略该字段**。因为 G1.1 的语义是"`undefined` = 用默认工作日"，
  而空数组是"没有任何工作日"（`Calendar` 会抛错）。若规范形状写出 `[]`，
  往返回来的文档就会变成**非法文档**。因此"省略"在这里是**语义的一部分**，不是省字节。
- `exceptions` 的两个集合**始终显式写出**（即使是空数组）：空数组对 G1.1 是合法输入，
  显式写出让"未启用例外"与"误删字段"在 diff 中可区分。

## 三、公共 API

```ts
// 序列化与解析
serializeDocument(doc): string                  // 规范 JSON 文本（稳定键序、2 空格缩进、结尾换行）
parseDocument(text): ProjectDocument            // JSON.parse → migrateDocument → 严格校验；有 error 即抛
canonicalizeDocument(doc): JsonValue            // 键序固定、字段齐全的 JSON 值（幂等）
createEmptyDocument(name?): ProjectDocument
reindexDocument(doc): ProjectDocument           // 重算全部 outlineNumber（修复动作）

// 校验（不抛错，返回全部诊断）
validateDocument(input: unknown): readonly DocumentDiagnostic[]
hasDocumentErrors(diagnostics): boolean

// 迁移（只做结构改写，不做字段校验）
migrateDocument(input: unknown): unknown

// WBS 层级
buildTaskTree(tasks) / flattenTaskTree(roots) / summaryTaskIds(tasks)
computeOutlineNumbers(tasks) / computeOutlineNumbersByScan(tasks) / computeDepths(tasks)
reindexTasks(tasks)
indentTask(tasks, id) / outdentTask(tasks, id) / moveTask(tasks, id, target)
isValidOutlineNumber(value) / outlineDepth(value) / parentOutlineNumber(value)

// 错误载体
DocumentError            // 有 error 级诊断（携带 diagnostics）
DocumentVersionError     // 版本未知 / 迁移路径缺失 / 迁移表成环
```

### 3.1 诊断

`DocumentDiagnostic = { code, severity, message, path?, taskId?, linkId? }`，
`severity ∈ { error, warning, info }`。`code` 是**稳定的字符串字面量联合**（`DocumentDiagnosticCode`），
G3 的导入诊断报告与测试都据此断言，**码值不随实现变化**。

- `error`：`parseDocument` 会抛；也意味着文档不可用。
- `warning`：可表达但可疑。例：`TASK_MILESTONE_WITH_DURATION`、`TASK_DURATION_WITHOUT_DATES`、
  `LINK_SUMMARY_ENDPOINT`。
- `info`：形状层面的提醒，不阻断。例：`DOC_FIELD_OMITTED`（顶层字段缺键）。

前缀分组：`DOC_*` 形状与版本、`PROJECT_*`/`CALENDAR_*`/`TASK_*`/`LINK_*`/`BASELINE_*` 各域、
`TREE_*` 层级不变量、`MIGRATION_CYCLE`。

### 3.2 调级操作的返回约定

`indentTask` / `outdentTask` / `moveTask` 返回**判别联合**而不是抛错：

```ts
type WbsResult<T> = { ok: true; value: T } | { ok: false; code: WbsFailureCode; message: string }
```

理由：**"拖到最外层再按 Shift+Tab"是正常交互，不是异常**。调用方（G5）据 `code` 决定提示文案，
并据此**跳过撤销栈压入**（`WBS_SAME_POSITION` 表示无操作）。

`WbsFailureCode`：`WBS_TASK_NOT_FOUND`、`WBS_NO_PREVIOUS_SIBLING`、`WBS_ALREADY_AT_ROOT`、
`WBS_TARGET_NOT_FOUND`、`WBS_TARGET_INDEX_OUT_OF_RANGE`、`WBS_CYCLE`、`WBS_DEPTH_EXCEEDED`、
`WBS_SAME_POSITION`。

### 3.3 调级的落点语义

- **Tab（`indentTask`）**：成为**前一个兄弟**的最后一个子节点。
  没有前一个同级任务 → `WBS_NO_PREVIOUS_SIBLING`（若该任务已是其父节点的唯一子节点，则报 `WBS_SAME_POSITION`）。
- **Shift+Tab（`outdentTask`）**：字段意义上移到原父节点的下一个兄弟位；
  **实现上落在"原父任务整棵子树之后"**，因此在文档序里紧邻原父节点的最后一个后代之后。
  原父节点的其他子节点仍排在被移动任务之前（这才是"升级"的直觉）。
- **移动一定会带走整棵子树**。只移动任务本身会破坏「父节点先于子节点出现在文档序」这一不变量
  （父节点挪到后面、子节点留在前面），而该不变量是编号算法与"兄弟顺序 = 文档序"共同的前提。
- **兄弟顺序 = 文档序**（`tasks[]` 的出现顺序）。本块不引入 `order` 字段；
  用户自定义排序属 P1-04，届时另立字段。
- **全量重建，不做增量索引**：`indent`/`outdent`/`move` 都重建树并重编号。
  依据 [S3 结论 §八 B.8](../../spikes/g0-s3-cpm-perf/结论.md)：1,000 规模上全量重建 p99 ≤ 180 µs，
  **先要可测的正确性**；增量优化需先用实测证明有收益。

## 四、版本与迁移

| 项 | 值 |
|---|---|
| 当前版本 | `CURRENT_DOCUMENT_VERSION = 3`（原文 §6 写死 `version: 3`） |
| 支持区间 | `1..3`（`MIN_SUPPORTED_DOCUMENT_VERSION = 1`） |
| 迁移实现 | 逐跳注册表 + 循环上界；每一步要求版本**严格递增** |
| 未知版本 | `0` / `4` / 非整数 / 非数字 → `DOC_VERSION_UNKNOWN`，**明确拒绝、不猜测** |

**v1 / v2 是"原文优先期"的历史形状，从未发布**（取舍与代价见 [ADR 0002](../../docs/02-adr/0002-文档模型与序列化契约.md)）：

| 版本 | 形状差异 | 迁移动作 |
|---|---|---|
| **v1** | `links[].lag`（而非 `lagDays`）；任务无 `manual`/`constraints`/`outlineNumber`/`collapsed`；无 `project.baseCalendarId` | v1→v2：`lag` → `lagDays`；补 `baseCalendarId`（回落 `calendars[0].id`）；任务补 `manual: false`、`constraints: []` |
| **v2** | 有 `manual`/`constraints`/`baseCalendarId`；无 WBS 与折叠状态 | v2→v3：任务补 `collapsed: false`、`outlineNumber`（**缺失时按层级计算填入**，已有值**保留**并由校验报 `TREE_OUTLINE_STALE`）；`baselines` 缺失补 `[]` |

**迁移只做结构改写，不做字段校验**——合法性由 `validateDocument` 负责，职责不重叠。
"已有 `outlineNumber` 不被静默改写"是刻意的：**真相源必须唯一**。

## 五、明确不做（本块边界）

| 项 | 归属 |
|---|---|
| `endDate` 与 `startDate + durationDays` 的一致性校验 | **G2 已定**（[ADR 0004](../../docs/02-adr/0004-排程契约.md) §2）：`endDate` 是**派生显示值、工期为准**，不一致只给 `info`（`endDateStale`），**校验从不改写文档** |
| 负 lag 越到项目起点之前的语义 | **G2 已定**（[ADR 0004](../../docs/02-adr/0004-排程契约.md) §4）：截断到项目起点 + 计数与诊断（`clampedStart`），**不阻断排程、不产出负序号**（[S3 §五.4](../../spikes/g0-s3-cpm-perf/结论.md)） |
| 汇总任务（有子任务）与排程的关系 | **G2 已定**（[ADR 0004](../../docs/02-adr/0004-排程契约.md) §3）：汇总任务**不参与排程**（派生值由引擎产出）；`LINK_SUMMARY_ENDPOINT` 保留 `warning`、该边在传播中**被忽略**；里程碑（工期 0）照常参与 |
| `constraints[]` 与 `manual` 的语义 | **v0.5**（R-3；本块只留位） |
| `baselines[].snapshot` 的内容 | **v0.5**（P1-03） |
| 折叠的渲染行为 | **G4**（本块只承载 `collapsed` 状态） |
| xlsx 列契约、依赖列语法、导入容差 | **G3**（见 [S2 结论 §八](../../spikes/g0-s2-xlsx-roundtrip/结论.md)） |
| 命令层与事务、撤销栈 | **G1.3 已落地**（[COMMAND.md](COMMAND.md) + [ADR 0003](../../docs/02-adr/0003-命令层与事务契约.md)；本文件只描述文档形状，变更通道见该规范） |
| 用户自定义排序 | **P1-04** |
| 多日历生效（v0.1 只有项目日历生效） | **v0.5+**（R-1） |

## 六、示例

```ts
import {
  createEmptyDocument,
  parseDocument,
  reindexDocument,
  serializeDocument,
  validateDocument,
  indentTask,
} from '@ganttpilot/engine';

// 新建 → 落盘
const doc = createEmptyDocument('试点项目');
const text = serializeDocument(doc);

// 读回（自动迁移 + 严格校验；有 error 抛 DocumentError）
const loaded = parseDocument(text);

// 调级（返回判别联合，不抛错）
const result = indentTask(loaded.tasks, 'b');
if (result.ok) {
  const saved = reindexDocument({ ...loaded, tasks: result.value });
  serializeDocument(saved);
} else {
  console.warn(result.code, result.message); // 例如 WBS_NO_PREVIOUS_SIBLING
}

// 导入向导：拿到全部诊断再决定是否放行
for (const diagnostic of validateDocument(JSON.parse(text))) {
  console.log(diagnostic.severity, diagnostic.code, diagnostic.path, diagnostic.message);
}
```
