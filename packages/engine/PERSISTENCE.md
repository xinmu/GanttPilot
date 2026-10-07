# `@ganttpilot/engine` 持久化规范（G6）

> **契约形状**（记录形状、存储接口、恢复语义、失败码）冻结在
> [ADR 0009](../../docs/02-adr/0009-持久化契约.md)；**本文件是它的落地说明**：
> 数值常量、公共 API 清单、逐条验证判据与记录制证据的指针。
> 与 `SCHEMA.md` / `COMMAND.md` / `SCHEDULE.md` 同层（包级规范，不是契约本体）。
> 本包**零 DOM、零框架**：本模块不出现 `indexedDB` / `window` / `document` / 定时器 / `Date.now()`。

## 一、本模块是什么

`src/persistence.ts` 只交**纯函数与纯状态机**：

```
        session（不可变值）                  时钟 / 手势状态 / writerId（**显式入参**）
              │                                            │
              ├── sessionRecordOf ──────────────────────────┴──► StoredSession（要写的那条记录）
              │
              ├── restoreSessionOf(record) ──► { session, resolvedFrom, stepsApplied }
              ├── planRestoreOf({latest, snapshots}, calendar) ──► 恢复计划（L3 → 检查点 → null）
              ├── policyReduce(state, event) ──► { action: none|flush|checkpoint|degrade }
              └── planCheckpoint(set, keep, meta) ──► { keep, delete }
```

**存储访问只在 `SnapshotStore` 接口后面**：引擎内提供 `createMemorySnapshotStore()`，
浏览器实现（IndexedDB）在 `apps/web/src/persistence/idb.ts`。因此 Node 侧的门禁测的是
**记录形状与策略**，而 IDB 的字节行为归记录制（ADR 0009 §5）。

## 二、数值常量（形状由 ADR 冻结；数值由本节的 spec 断言）

| 常量 | 值 | 依据与含义 |
|---|---|---|
| `AUTOSAVE_DEBOUNCE_MS` | `2000` | 连续编辑只写一次（去抖） |
| `AUTOSAVE_MAX_INTERVAL_MS` | `5000` | **≤5s 的落地方式**：去抖上限封顶，故最坏"变更 → 落盘"延迟 ≈ 5 s，而不是"整个会话不写" |
| `CHECKPOINT_INTERVAL_MS` | `300000`（5 分钟） | R-2 建议值（[裁决R01-02（依据）](../../docs/00-baseline/裁决R01-02.md) §一 R-2 的分层建议） |
| `CHECKPOINT_EVERY_STEPS` | `200` | 同上 |
| `CHECKPOINT_KEEP` | `3` | R-2 的"保留 2–3 份"，取上界 |
| `QUOTA_DEGRADED_KEEP` | `1` | 配额超限后只留最近 1 份，并提示 |
| `PERSIST_RECORD_VERSION` | `1` | 记录形状版本；与文档的 `CURRENT_DOCUMENT_VERSION`（§`SCHEMA.md`）**分开**：记录形状与文档形状的演进不是一回事 |

> **为什么这些值住在 spec 而不是 ADR**：它们是可调的"数值"，不是"形状"。
> 与 ADR 0007/0008 的分工一致（ADR 冻结形状与语义、spec 回填数值），
> 这样调参不需要新 ADR，而形状变更必须新 ADR。

**待定清单的收口**：`首版-待定清单.md` §七 的「检查点触发条件与保留份数」由本表**定值**，
并在记录层写明（裁决 `P-33`）。若将来调值，改本表 + spec 一行即可，路线图与 ADR 不动。

## 三、公共 API（`src/index.ts` 的导出面）
| 导出 | 作用 |
|---|---|
| `PERSIST_RECORD_VERSION`、`PERSIST_FAILURE_CODES` | 记录版本与**失败码闭集**（后者由 spec 断言与联合类型逐值一致） |
| `AUTOSAVE_DEBOUNCE_MS`、`AUTOSAVE_MAX_INTERVAL_MS`、`CHECKPOINT_INTERVAL_MS`、`CHECKPOINT_EVERY_STEPS`、`CHECKPOINT_KEEP`、`QUOTA_DEGRADED_KEEP` | §二的数值 |
| `sessionRecordOf(session, base, meta)` | 纯构造：由会话与"当前基线快照"算出**要写的那条记录**（`post` = 基线之后的所有 undo 步） |
| `restoreSessionOf(record, calendar)` | 由记录还原 `DocumentSession`（含 undo/redo 栈）；坏记录返回 `PERSIST_RECORD_INVALID` |
| `planRestoreOf(candidates, calendar)` | 恢复优先级：最新状态 → 检查点（`createdAtMs` 新到旧）→ `null`；**坏候选只跳过** |
| `createRetentionPolicy(overrides?)` / `policyReduce(state, event)` | 触发状态机（事件含 `rev` / `atMs` / `active` / `count` / `quotaExceeded`） |
| `planCheckpoint(set, keep, meta)` | 保留/删除集合（确定性） |
| `createMemorySnapshotStore()` | 内存适配器（Node 侧测试 + 浏览器降级） |

> **检查点 id 的领取方式**：写入时给 `id: 0` 占位，**存储实现分配真实自增 id**；
> 写完之后按 `createdAtMs` 读回来认领它（`usePersistence.writeCheckpoint`）——
> 因为记录里的 `base` 必须带**可删除的引用**（`planCheckpoint` 的 `remove` 要按 id 删）。
| `restoreSession(document, undoSteps, redoSteps, revision)`（`session.ts`） | 会话构造的**导出入口**（避免手搓 `DocumentSession` 字面量）；与 `createSession` 同族 |

## 四、实现不变量（**产品路径**也成立的纪律，不只是测量口径）

三条，都是 G6 落地时**被实测或缺陷逼出来**的：

| # | 不变量 | 依据 |
|---|---|---|
| ① | **增量部分的体积与文档规模解耦**：只有检查点写整份文档；"最新状态"写的是 `base` 之后的增量（`post`），每步的日志条目数只与变更量同阶 | R-2 的瓶颈是写入延迟；实测（`--storage-metrics`，2,000 任务）**整份文档 623.4 KB / 1.4 ms** 对**增量记录 0.15 KB / 0.3–0.8 ms**；跨规模方向断言在 `persistence.spec.ts` |
| ①' | **诚实口径**：记录里 `base` **带整份基线快照**，因此基线建立之后每次写入含一份固定基线体积（"杀进程仍能恢复"的代价）。把基线改成存储引用属 v0.5 的写入量优化 | 同上一次实测；ADR 0009 §1 |
| ② | **`flushNow` 是强制收口**（`松手` / 文档隐藏 / `pagehide` / 测量）：**不等去抖窗口**，按步数阈值决定要不要先落新检查点 | 出口条件①的时效口径是"变更 → 落盘完成 ≤5s"；等待去抖会把它拖成"看起来没写"（实测：不改的话"松手→落盘"恒为空） |
| ③ | **整份替换文档时必须重定基线**（`rebaseNow`）：内存里的 `base` 要作废并立刻写一份新检查点 | 实测抓到的缺陷：换夹具后基线仍是**上一份文档**的快照，于是每次写盘都把旧文档带上（记录 316 KB，而当时的文档只有 300 KB 级）——产品上对应"导入 / 恢复换了整份文档" |

> ③ 由 `apps/web` 的 `usePersistence.rebaseNow()` 承担（引擎侧只提供 `sessionRecordOf` 与
> `writeCheckpoint` 的语义；"什么时候该重定"是调用方的知识）。规格测试守住 ① 的**方向**
> （小夹具上 `recordBytes < documentBytes`），绝对倍数由记录制证据给。

## 五、验证矩阵

> 判据的**唯一登记处**（与 `SPEC.md` §九 / `SCHEDULE.md` 同口径）。
> 出口条件编号沿用[路线图 G6](../../docs/01-roadmap/首版能力顺序.md) 的四条。

| 层 | 手段（住哪个 spec） | 判据 | 进 `pnpm gate`？ |
|---|---|---|---|
| ① 记录形状 | `persistence.spec.ts` | `sessionRecordOf` → `restoreSessionOf` **逐字段深比较等价**（文档 + revision + 两个栈的步数与顺序）；`post` 与基线的关系（基线之后的步数精确）；`commands`/`journal` 经 JSON 往返后仍等价（落盘就是 JSON） | **进** |
| ① 失败码闭集 | 同上 | `PERSIST_FAILURE_CODES` 与联合类型逐值一致；**每码至少一条负向用例**（不可用 / 配额 / 多标签 / 坏记录 / 写失败） | **进** |
| ② ≥50 步 LIFO | 同上 | 单个检查点之后连续 **50** 步命令：恢复后 `undoStack.length` = 50、**逐步撤销 50 次**回到检查点处的文档（逐次与"未持久化的原会话"深比较相等）、再做 50 次重做回到终点 | **进** |
| ② 跨检查点 | 同上 | 200 步（跨过两次检查点）后恢复：撤销可用步数 = 检查点之后的步数 + 检查点基线本身（即基线**不**因新检查点而丢失当前状态）；撤销到"检查点基线状态"后栈空，**不会**越界 | **进** |
| ② 重做栈 | 同上 | `post` 为空时 redo 栈完整恢复（`post → 撤销 → 重做` 序列在恢复后逐值成立）；`post` 非空且 `redo` 非空 ⇒ `PERSIST_RECORD_INVALID`（免费不变量） | **进** |
| ② 互证律 | 同上 | `apply(apply(d, j), invert(j)) ≡ d` 在**恢复路径**上同样成立（复用 G1.3 的对合律，不重写） | **进** |
| ③ 恢复优先级 | 同上 | L3 存在 ⇒ 用 L3（`resolvedFrom='latest'`）；L3 缺失/坏 ⇒ 用检查点（`resolvedFrom='checkpoint'`）；全坏/全无 ⇒ `null`（调用方回落演示文档）；**坏候选不阻断**后面的候选 | **进** |
| ③ 坏记录负向对照 | 同上 | 逐条构造并断言**被拒且给出对应码**：文档版本不受支持、文档含 error 诊断、`post` 里某步 `journal.before` 与当前文档不符、命令形状非法、`redo` 与 `post` 并存、`docId` 不匹配、`rev` 非有限数 | **进** |
| ③ killsim（Node 侧） | 同上 | "L3 永远写"的模型下：**杀掉写者**（停止调用 `saveLatest`）后，`planRestoreOf` 仍给出一条可恢复记录（= 最后一次成功写入），且其 `rev` **≥** 最近检查点的 `rev` | **进** |
| ④ 检查点触发 | 同上（**假时钟**） | 距上次检查点 ≥5 min ⇒ `checkpoint`；累计 ≥200 步 ⇒ `checkpoint`；`close` ⇒ `checkpoint`；`active='dragging'` 期间**不产出 flush**、`idle` 后补写；去抖 ≤ 最大间隔（**不**因为连续编辑把写入无限推迟） | **进** |
| ④ 保留份数 | 同上 | `planCheckpoint` 在 `keep=3` 下是**确定性**集合运算（与时钟、插入顺序无关）：满额后新增一份 ⇒ 删除最旧一份；`keep=1`（降级）下新增一份 ⇒ 删除其余全部 | **进** |
| ④ 配额降级 | 同上 | 写者收到 `QUOTA_EXCEEDED` ⇒ `policyReduce` 产出 `degrade` ⇒ 此后 `keep=1`；降级只改保留份数，**不改编辑行为**（会话与命令层不受影响） | **进** |
| ④ 多标签防护 | 同上 | 记录 `writerId` 与当前标签页不同且更新 ⇒ `saveLatest` 返回 `BLOCKED_BY_OTHER_TAB` 且**不覆盖**已有记录（负向对照：同一 `writerId` 则正常写入） | **进** |
| ④ 降级路径 | 同上 | `SnapshotStore` 不可用 ⇒ 内存适配器接管：会话内行为与 IDB 路径**逐值一致**（同一组断言跑两遍） | **进** |
| ④ 写入量方向（不变量①） | 同上 | 同一个"只改一个字段"的命令：**日志条目数 = 1（不随文档规模增长）**，且小夹具与 500 任务夹具的单步体积同量级（差 < 64 B）；绝对倍数由记录制证据给 | **进** |
| ⑤ 浏览器：自动保存不吃拖拽帧 | `scripts/measure-render.mjs --persist-drag`（打包产物） | 开/关持久化两组同尺：帧间隔 p95 ≤ 33.3 ms、主线程工作量 p95、longtask 数；拖动期**持久化写入次数 = 0** | **不进**（记录制，需本机 Chrome） |
| ⑤ 浏览器：存储占用与写入耗时 | `scripts/measure-render.mjs --storage-metrics`（打包产物，**2,000 任务**） | `navigator.storage.estimate()` 的用量、单次 L3 记录体积、单次 IDB put 墙钟（p50/p95）、整份文档序列化体积与耗时、恢复耗时 | **不进**（记录制） |
| ⑤ 浏览器：杀进程恢复 | `scripts/measure-render.mjs --persist-drag`（同轮） | 写入若干步 → `Page.crash` → 重开：恢复出的 `rev` **≥** 最近检查点的 `rev`（按 ADR 0009 §8 的**字面**口径） | **不进**（记录制） |

## 五、夹具与前置

- 复用具名夹具（`fixtures.ts` / `commandFixtures.spec.ts`）与**确定性命令序列**生成器，
  不引入随机数：恢复判据必须可重复（与 `COMMAND.md` §7 的"命令层不生成 id"同源）。
- 规模口径：门禁侧默认小夹具（秒级）；**2,000 任务**只在记录制（浏览器）里测——
  与路线图 §五「2,000 任务压测归 v0.5」不冲突（本块只测"存储占用与写入耗时"一条）。

## 六、明确不做（本模块边界）

- 命令压缩/合并、增量索引、Worker 化、云同步、多标签合并（ADR 0009 §备选）；
- 会话锚点/滚动位置/档位跨会话恢复（ADR 0009 §6）；
- 按时间点的浏览式历史（US-5 已按 R-2 改写为"跨会话恢复至最近检查点"）；
- 存储迁移（记录形状 v1 之前无历史数据；形状演进时另立 ADR + 迁移）。
