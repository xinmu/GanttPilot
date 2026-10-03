# 命令层规范（G1.3）

> 本文件是 `@ganttpilot/engine` **命令层**（`packages/engine/src/journal.ts`、`command.ts`、`session.ts`）
> 的**权威说明**，供 G5（编辑体验：拖拽三语义 + 撤销重做）、G6（持久化：命令回退栈）与 G4（渲染）
> 共同引用。决策依据与取舍见 [ADR 0003](../../docs/02-adr/0003-命令层与事务契约.md)；
> 文档形状见 [SCHEMA.md](SCHEMA.md)（本层**不改变**文档 schema，`version` 仍为 3）。

## 一、四条铁律

1. **文档的变更只有一个通道**：所有变更都是 `DocumentCommand`，由纯函数 `applyCommand` 执行。
   `applyCommand` **绝不修改入参**，也不返回与入参共享可变更部分的"半成品"。
2. **命令层产出的文档必然通过 schema 校验**：`applyCommand` 在放行前直接调用 G1.2 的
   `validateDocument`，任何 `error` 级诊断都会变成失败码 `CMD_RESULT_INVALID`（并附带该诊断）。
   命令层**不重写**任何文档规则——规则只有一处（`schema.ts`）。
3. **逆操作来自 before 镜像，不手写逆逻辑**：命令成功时返回 `journal`（受影响实体的 before/after
   镜像 + 顺序镜像）；`invertDocumentJournal(journal)` 即可精确回滚。
4. **无操作是正常交互**：恒等 patch 与 `WBS_SAME_POSITION` 返回 `{ok:true, changed:false}`，
   调用方应据此**跳过撤销栈压入**（同 `SCHEMA.md` §3.2 的 `WbsResult` 口径）。

## 二、命令清单

`COMMAND_KINDS`（11 个，顺序稳定）：

| kind | 载荷 | 前置条件（失败码见 §六） |
|---|---|---|
| `document.replace` | `document`（完整 `ProjectDocument`，`version` 必须是当前版本、五段齐全） | 载荷零 `error` 诊断 |
| `project.update` | `patch`（`name`/`description`/`baseCalendarId`/`startDate`/`finishDate`） | `baseCalendarId` 为空串或存在于 `calendars[]` |
| `task.insert` | `task`（完整 `DocumentTask`）、`parentId`、`afterTaskId?`/`index?` | id 非空且唯一；`parentId` 存在；载荷 `parentId` 与命令一致 |
| `task.update` | `id`、`patch`（见下） | 任务存在；patch 不含 `id`/`parentId`/`outlineNumber` |
| `task.remove` | `id` | 任务存在（**带走整棵子树**并级联删除相关依赖边） |
| `task.indent` | `id` | 透传 `indentTask`（Tab：成为前一个兄弟的最后一个子节点） |
| `task.outdent` | `id` | 透传 `outdentTask`（Shift+Tab） |
| `task.move` | `id`、`target`（`{parentId, index?, afterTaskId?}`） | 透传 `moveTask`（跨层级移动 + 全量重编号） |
| `link.insert` | `link`（完整 `DocumentLink`） | id 唯一；两端点存在；非自环 |
| `link.update` | `id`、`patch`（`from`/`to`/`type`/`lagDays`） | 边存在；补丁后的端点存在且非自环 |
| `link.remove` | `id` | 边存在 |

**`task.update` 的可改字段**（其余一律 `CMD_INVALID_PAYLOAD`）：
`name`、`startDate`、`endDate`、`durationDays`、`progress`、`milestone`、`collapsed`、
`notes`、`manual`、`constraints`。

三条容易踩的口径：

- **patch 是稀疏的**：没写的键 = 不改；写 `null` = 清空（`null` 是"缺失"的唯一写法，见 `SCHEMA.md`）。
- **`outlineNumber` 是派生值**：`task.insert` 会按层级重算并**忽略载荷取值**（ADR 0002 ④）；
  而 `parentId` 是真相源，载荷与命令不一致时**拒绝**（不做静默改写）。
- **载荷的多余键**：命令顶层的多余键被忽略（向前兼容），但 **patch 里的多余键被拒绝**
  （那是错字，静默忽略会让用户以为改动已生效）。

## 三、公共 API

```ts
// 执行
applyCommand(document, command): CommandResult        // 纯函数；唯一变更通道
replayCommands(document, commands): ReplayResult      // 顺序重放；失败即停并给前缀状态与下标
checkCommandShape(input): { ok, command } | { ok:false, code, message }   // 校验并规范化

// 序列化（外部输入的唯一入口）
serializeCommand(command): string                     // 规范键序、紧凑单行；非法命令抛 RangeError
parseCommand(text): { ok:true, command } | { ok:false, code, message }

// before 镜像（日志）——"唯一变更内核"
diffDocument(before, after): DeltaJournal             // 细粒度差分（整体深冻结）
createBulkJournal(before, after): BulkJournal         // 整份文档镜像（批量替换用）
applyDocumentJournal(document, journal): ProjectDocument
invertDocumentJournal(journal): DocumentJournal       // 对合：取逆两次回到原日志
isJournalEmpty(journal): boolean
journalScope(journal): JournalScope                   // 受影响 id 集合 / 是否整份替换

// JSON 值与比较工具（日志与载荷校验共用）
findNonJsonValue(value, path?): string | null
cloneJsonValue(value): T                              // 深拷贝；非 JSON 值抛 RangeError
deepFreezeJson(value): T                              // 就地深冻结（幂等、可处理环）
jsonDeepEqual(left, right): boolean                   // 键序无关的结构化比较

// 会话与事务
createSession(document, revision?) / createTransaction(commands?) / addToTransaction(tx, command)
applyToSession(session, command) / commitTransaction(session, transaction)
undoSession(session) / redoSession(session)

// id 建议（确定性；命令层自己**不**生成 id）
suggestTaskId(document, prefix?) / suggestLinkId(document, prefix?)
```

## 四、结果语义与日志形状

### 4.1 三种结果

```ts
type CommandResult =
  | { ok: true; changed: true;  document: ProjectDocument; journal: DocumentJournal }
  | { ok: true; changed: false; document: ProjectDocument }          // 无操作：不压栈
  | { ok: false; code: CommandFailureCode; message: string; diagnostics?: readonly DocumentDiagnostic[] };
```

### 4.2 日志 = before 镜像（两种形态）

```ts
type DocumentJournal =
  | { kind: 'delta';
      project: { before: ProjectMeta; after: ProjectMeta } | null;
      tasks: readonly { id: string; before: DocumentTask | null; after: DocumentTask | null }[];
      links: readonly { id: string; before: DocumentLink | null; after: DocumentLink | null }[];
      taskOrder: { before: readonly string[]; after: readonly string[] } | null;
      linkOrder: { before: readonly string[]; after: readonly string[] } | null }
  | { kind: 'document'; before: ProjectDocument; after: ProjectDocument };
```

- **`null` = 该实体在这一侧不存在**（新增/删除）；
- **条目按 id 定位**，因此同一份 delta 内的应用顺序无关紧要；顺序字段最后应用；
- **`document` 形态只用于批量替换**（`document.replace`）。它同时是"最后一个防线的形状"：
  细粒度命令**不允许**退化成整份镜像（`documentPerformance.spec.ts` 有体积断言）。

### 4.3 引用纪律（避免"共享可变对象导致回滚失败"）

| 环节 | 规则 |
|---|---|
| 构造日志 | `deepFreezeJson(cloneJsonValue(value))`——冻结的是**克隆体**，与任何文档零共享引用 |
| 应用日志 | 写回**新鲜（未冻结）克隆**；未受影响实体按引用复用 |
| 调用方文档 | **永不冻结**（`apps/web` 的 Vue 响应式依赖可写性） |

`applyDocumentJournal` / `invertDocumentJournal` 遇到**自相矛盾**的日志
（`before` 与当前文档不符、顺序字段与实体集不符）抛 `RangeError`：那是**程序员错误**；
由 `applyCommand` 产出的日志永不触发（单测另有负向用例证明守卫有牙）。

### 4.4 序列化形态

- **命令**：纯 JSON，`serializeCommand` 固定键序、紧凑单行；`parseCommand` 是外部/持久化输入的
  唯一入口，未知 `kind` 明确拒绝（`CMD_UNKNOWN_KIND`）；
- **日志**：纯 JSON（`JSON.parse(JSON.stringify(journal))` 与原值深比较相等，且应用结果逐项一致）。
  日志是**派生输出**（不是用户输入），因此没有 `parseJournal`；G6 若要落盘请自行 `JSON.parse`
  并自行决定校验策略。

## 五、会话与事务

```ts
interface DocumentSession {
  document: ProjectDocument;
  revision: number;                        // 状态版本计数：应用/撤销/重做都 +1，单调不减
  undoStack: readonly SessionStep[];        // 栈顶在末位（LIFO）
  redoStack: readonly SessionStep[];
}
interface SessionStep { commands: readonly DocumentCommand[]; journal: DocumentJournal }
```

| 操作 | 语义 |
|---|---|
| `applyToSession(session, command)` | 成功且 `changed` → 压一条 step、**清空 redo 栈**、`revision+1`；无操作 → 会话原样（**不清 redo 栈**）；失败 → 会话原样 |
| `commitTransaction(session, transaction)` | 成员按序执行；**任一失败则会话完全不变**（`failedIndex` 指出失败成员）；成功且净效果非空 → **只压一条** step |
| `undoSession(session)` | 应用 `invertDocumentJournal(step.journal)`；step 移到 redo 栈；栈空 → `SESSION_NOTHING_TO_UNDO` |
| `redoSession(session)` | 正向应用 `step.journal`（`after` 已在镜像里，**不重跑命令**）；栈空 → `SESSION_NOTHING_TO_REDO` |

- **IX-03 的落地**：能表达成一条命令的手势就是一条命令；需要多步的手势提交为一个事务，
  **仍然是一个撤销单元**——一次 Ctrl+Z 回退整次手势。
- **事务合并日志 = 起点与终点的差分**（`diffDocument`），自动处理"插入后又删除"这类抵消；
  单命令事务直接用该命令的日志（`document.replace` 因此保留整份镜像形态）。
- **会话是不可变值**（纯函数转换，无隐藏状态、无订阅）：`apps/web` 用 `ref` 持有即可，
  G6 可直接把 `undoStack`/`redoStack` 序列化落盘。

## 六、失败码

```ts
type CommandFailureCode =
  | 'CMD_VERSION_MISMATCH'          // 文档不是当前版本（迁移归 parseDocument）
  | 'CMD_INVALID_PAYLOAD'           // 载荷形状/类型/取值非法（含非 JSON 值）
  | 'CMD_UNKNOWN_KIND'              // 未知命令类型（parseCommand 的外部输入）
  | 'CMD_RESULT_INVALID'            // 结果未通过 schema 校验（附带 diagnostics，见下）
  | 'CMD_TASK_NOT_FOUND' | 'CMD_TASK_ID_DUPLICATE'
  | 'CMD_PARENT_NOT_FOUND' | 'CMD_ANCHOR_TASK_NOT_FOUND'
  | 'CMD_LINK_NOT_FOUND' | 'CMD_LINK_ID_DUPLICATE'
  | 'CMD_LINK_ENDPOINT_NOT_FOUND' | 'CMD_LINK_SELF_REFERENCE'
  | 'CMD_CALENDAR_NOT_FOUND'
  | 'WBS_NO_PREVIOUS_SIBLING' | 'WBS_ALREADY_AT_ROOT' | 'WBS_TARGET_INDEX_OUT_OF_RANGE'
  | 'WBS_CYCLE' | 'WBS_DEPTH_EXCEEDED';   // WBS_SAME_POSITION **不在其中**：它是无操作，见下

type SessionFailureCode = CommandFailureCode | 'SESSION_NOTHING_TO_UNDO' | 'SESSION_NOTHING_TO_REDO';
```

**`WbsFailureCode` 的归一**（`WbsResult` 的码不会原样出现在命令结果里）：

| `WbsFailureCode` | 命令层 |
|---|---|
| `WBS_TASK_NOT_FOUND` | `CMD_TASK_NOT_FOUND` |
| `WBS_TARGET_NOT_FOUND` | `CMD_PARENT_NOT_FOUND`（落点任务缺失时报 `CMD_ANCHOR_TASK_NOT_FOUND`） |
| `WBS_SAME_POSITION` | `{ok:true, changed:false}`（无操作，不是失败） |
| 其余五个 | **逐值透传** |

`CMD_RESULT_INVALID` 的 `diagnostics` 就是 `validateDocument` 的 `error` 级诊断
（例：`task.update` 让 `endDate` 早于 `startDate` → `TASK_END_BEFORE_START`）。
**需要 `warning` 级提示**（例：依赖边端点指向汇总任务）的调用方，请在提交后自行调
`validateDocument`——命令层不复制诊断面。

## 七、明确不做（本层边界）

| 项 | 归属 |
|---|---|
| 命令压缩/合并、检查点策略、IndexedDB 与配额、多标签页防护 | **G6** |
| 拖拽的吸附/冲突标记（IX-05）、逐帧传播与整帧性能 | **G5**（逐帧计算属 **G2** 的传播闭包） |
| 日历单独编辑命令、`baselines[]` 编辑 | **v0.5**（多日历 R-1 / 基线 P1-03） |
| 排程结果是否写回文档 | **G2**（`SCHEMA.md` §五 留待） |
| 协作/OT/CRDT 预留 | 非目标 NG-01 |
| 命令层的增量索引 | 不做（先要可测的正确性；同 `SCHEMA.md` §3.3） |

## 八、示例

```ts
import {
  applyToSession, commitTransaction, createSession, createTransaction, redoSession, undoSession,
  validateDocument, type DocumentCommand,
} from '@ganttpilot/engine';

// 一次拖拽：改开始 + 改工期（跨字段，一条命令）
let session = createSession(loaded);
const drag: DocumentCommand = {
  kind: 'task.update',
  id: 't3',
  patch: { startDate: '2025-03-10', durationDays: 6 },
};
const applied = applyToSession(session, drag);
if (applied.ok && applied.changed) {
  session = applied.session;               // 一次手势 = 一条命令 = 一层撤销
}

// 需要多步的手势：一个事务，仍然只占一层撤销
const gesture = createTransaction([
  { kind: 'task.indent', id: 't4' },
  { kind: 'task.update', id: 't4', patch: { progress: 0.5 } },
]);
const committed = commitTransaction(session, gesture);
if (!committed.ok) {
  console.warn(committed.code, committed.message, committed.failedIndex);  // 会话完全未变
}

// Ctrl+Z / Ctrl+Y
const undone = undoSession(session);
const redone = redoSession(undone.ok ? undone.session : session);
if (redone.ok) {
  session = redone.session;
}

// 需要 warning 级提示时（例如依赖边端点是汇总任务），提交后自行校验
for (const diagnostic of validateDocument(session.document)) {
  if (diagnostic.severity === 'warning') {
    console.warn(diagnostic.code, diagnostic.message);
  }
}
```
