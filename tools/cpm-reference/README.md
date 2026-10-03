# `tools/cpm-reference`：排程内核的独立参照实现

> **这不是移植，是"另一种写法"。** 它与 `packages/engine/src/schedule.ts` 只共享
> [SCHEDULE.md](../../packages/engine/SCHEDULE.md) 声明的**字段与语义契约**，
> 不共享任何一行代码：图算法（DFS 三色 vs Kahn 入度）、日期承载（`datetime.date` 逐日推进
> vs 整数序号 + 前缀和索引）、数据结构（`list`/`dict` vs CSR + 类型化数组）全部不同。
> 依据见 [裁决 P-12](../../docs/00-baseline/裁决记录.md) 第 5 条与
> [ADR 0004 §9](../../docs/02-adr/0004-排程契约.md)、[ADR 0005](../../docs/02-adr/0005-排程内核落地补齐与结果形状.md)。
>
> **它为什么不在 `packages/engine` 里**：三包（engine / xlsx-protocol / pptx-renderer）**不放非 TS 资产**。
> 差分测试本体在 `packages/engine/src/schedule.differential.spec.ts`，因此**差分就在 `pnpm gate` 的
> `test` 步骤里真实运行**——**缺 Python 3 时该步失败，而不是静默跳过**。

## 一、用法

```bash
python cpm_reference.py <input.json> <output.json>
```

- 解释器解析由调用方（TS 侧）负责：`GANTTPILOT_PYTHON` → `python` → `python3` → `py -3`，
  并**先用 `<解释器> --version` 探测可用性**（`stdio: 'ignore'`，不走管道），
  探测不到就换下一个候选——因此"本机没有 Python"会报**"无法启动独立参照实现"**，
  而不是被误诊成"参照实现跑失败了"；
- Windows 上 `python` 常是 `.bat` 垫片，`spawnSync` 直接执行会得到**退出码 9009**（不是 `ENOENT`）
  或 `'python' is not recognized ...` + 退出码 1；TS 侧对两种情况都会退回到 `cmd.exe /d /s /c` 执行——这不是脚本失败；
- 走**文件进出**（不是 stdio 管道）：可复算、可调试，也不受子进程管道实现差异影响；
- 退出码 0 = 成功；2 = 参数个数不对；非 0 = 参照实现自身出错（差分判为失败）。

## 二、输入协议

```jsonc
{
  "projects": [
    {
      "id": "diff-dag-0",
      "baseDay": 20713,              // Calendar.baseDay（1970-01-01 = 0）；序号相对它计数
      "spanDays": 1460,              // 调用方日历的初始地平线（参照实现可忽略，仅留痕）
      "calendar": {
        "id": "project",
        "workDays": [1, 2, 3, 4, 5], // 0=周日 … 6=周六；省略 = 默认周一至周五
        "exceptions": {
          "nonWorking": ["2026-10-12"], // 「工作日 → 非工作日」；同日冲突时**非工作日优先**
          "working": ["2026-10-17"]     // 「休息日 → 工作日」
        }
      },
      "projectStartDate": "2026-10-05",  // 或 null
      "anchors": [                        // 会话锚点（原始口径，可含非法项）
        { "taskId": "t3", "startOrdinal": 5 }
      ],
      "tasks": [
        {
          "id": "t1",
          "parentId": null,               // 或父任务 id（父必先于子出现）
          "startDate": "2026-10-05",      // 或 null
          "endDate": "2026-10-09",        // 或 null
          "durationDays": 4,              // 或 null
          "progress": 0.5,                // 或 null
          "milestone": false
        }
      ],
      "links": [
        { "id": "l1", "from": "t1", "to": "t2", "type": "FS", "lagDays": 0 }
      ]
    }
  ]
}
```

- `type` ∈ `FS` / `SS` / `FF` / `SF`；`lagDays` 是**工作日**整数、可为负；
- `calendar` 就是**文档里的 `CalendarSpec`**（例外嵌在 `exceptions` 下，见 `packages/engine/SCHEMA.md`）；
  参照实现同时容忍「`nonWorking`/`working` 直接挂在日历块上」的扁平写法（S3 口径），以 `exceptions` 优先；
- `tasks` 的**文档序**即索引序：输出数组与它一一对应（与 `Schedule` 的索引约定一致）；
- 任务字段与 `packages/engine/SCHEMA.md` 的 `DocumentTask` 同义，**参照实现必须自行完成**
  序号翻译、工期解析、项目起点、锚点分类、汇总聚合 —— 这些正是差分要覆盖的语义。

## 三、输出协议

```jsonc
{
  "results": [
    {
      "id": "diff-dag-0",
      "hasCycle": false,
      "taskCount": 12,
      "es": [0, 4, -1],              // 叶子：序号；汇总：-1
      "ef": [4, 8, -1],
      "anchored": [1, 0, 0],
      "driven": [0, 1, 0],
      "summaryEs": [-1, -1, 0],      // 叶子：-1；汇总：子树 min(es)
      "summaryEf": [-1, -1, 8],
      "summaryProgress": [-1, -1, 0.5],   // NaN 必须写成 null（JSON 没有 NaN）
      "milestoneCount": 2,
      "projectStart": 0,
      "projectFinish": 8,
      "clampedStarts": 1,
      "esIso": ["2026-10-05", "2026-10-09", null],  // 汇总（es<0）写 null
      "efIso": ["2026-10-09", "2026-10-15", null],
      "diagnostics": [                            // 只比对 code + taskId/linkId
        { "code": "undated", "taskId": "t5", "linkId": null }
      ]
    },
    { "id": "diff-cyc-0", "hasCycle": true }
  ]
}
```

- 成环图只输出 `{"id", "hasCycle": true}`（两侧都不产出排程）；
- `summaryProgress` 的 `NaN` **必须**序列化成 `null`；比对时 `null` 与 `NaN` 视为相等（容差 1e-9）；
- 输出用 UTF-8、紧凑分隔符（`, ` 与 `:` 均可，TS 侧用 `JSON.parse`），末尾换行。

## 四、语义清单（照 [SCHEDULE.md](../../packages/engine/SCHEDULE.md)）

参照实现必须逐条实现下面这些（**这是差分的判别力所在**）：

1. **序号空间**：`ordinalOfDay(d)` = `[baseDay, d)` 内的工作日数；`dayOfOrdinal(k)` = 第 k 个工作日
   （k=0 是 `baseDay` 当天或其后的首个工作日）；**负数序号无定义**；
2. **工期解析**：`durationDays` → `workdaysBetween(startDate, endDate)`（半开区间）→ `0`；
   "全部三个字段齐备而 `workdaysBetween ≠ durationDays`" 时给 `endDateStale`（info）——
   该诊断是**文档级一致性**事实，因此对**所有任务**判定（**含汇总任务**）；
3. **锚点四情形**（判定看**有效入边** = 排除汇总端点边）：
   ① 有日期无入边 → 文档日期序号；② 无日期无入边 → 项目起点 + `undated`；
   ③ 有入边无会话锚点 → `max(入边约束)`，日期被覆盖时 `dateOverridden` 且 `driven=1`；
   ④ 有入边有会话锚点 → `max(锚定序号, 入边约束)`，锚定更早时 `anchorConflict` 且 `anchored=1`；
4. **项目起点三级回落**：`projectStartDate` → **全部非空 `task.startDate` 的序号最小值** → `0`。
   **会话锚点不参与**；
5. **截断**：`raw < 项目起点` → `ES = 项目起点`、计数并在 `clampedStarts` 与 `clampedStart` 诊断中体现；
   早于 `baseDay` 的日期按序号 `0` 处理并计入 `clampedStart`；
6. **有效图**：传播**排除**任一端点为汇总任务的边（并报 `summaryIgnored`，带 `linkId`）；
   **检环用全部边**（结构性）；悬空边忽略；
7. **汇总任务**（有子任务者）不参与传播：`es/ef = -1`、`anchored/driven = 0`；
   `summaryEs = min(子树叶子 es)`、`summaryEf = max(子树叶子 ef)`、
   `summaryProgress = Σ(dᵢ·(progressᵢ ?? 0)) / Σdᵢ`（`Σdᵢ === 0` → `NaN`）；
8. **里程碑**：`milestone === true` 或 `durationDays === 0` 的**叶子**计入 `milestoneCount`；
   里程碑照常参与传播；
9. **锚点健壮性**：未知 `taskId` / 非有限整数序号 → `anchorUnknown` 并忽略；指向汇总任务 →
   `summaryIgnored` 并忽略；同一任务重复 → **后者胜**；
10. **留位字段**：`constraints` 非空或 `manual === true` → `constraintsUnused`（info）。
    输入协议里这两个字段可选；缺省视为"未启用"；
11. **诊断**：只比对 `code` + `taskId`/`linkId`（`message`/`path` 不比对）；severity 不比对；
12. **检环**：DFS 三色染色（递归，显式提高递归上限，深链最长 200）；
13. **`projectFinish`** = `max(ef)`（无叶子时 = `projectStart`）。

## 五、工程约束

- **零第三方依赖**（只用标准库 `json` / `sys` / `datetime`）；
- 输出确定性：同一输入 → 逐字节相同的输出；
- 控制台输出切 UTF-8（Windows 默认 GBK 会把中文日志打成乱码）；
- 深链用递归实现时必须 `sys.setrecursionlimit(...)`（S3 的先例：200,000）。
