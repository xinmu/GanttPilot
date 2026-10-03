# S1 · L1 结构自检报告

> 由 `node src/run-all.mts` 生成。本报告只覆盖**结构合法性**，不代表渲染正确性。

- 幻灯片尺寸：9144000 × 5143500 EMU（720 × 405 pt，与容器 `p:sldSz` 实测值一致）
- 容器形状：`bar-a`#2、`bar-b`#3、`ms-1`#4
- 补丁分配：connector id=5、group id=6、子形状 id=7、8
- 连线端点（绝对 EMU）：(2032000,1346200) → (6604000,3048000)

### 结构检查

共 27 条，通过 27 条，失败 0 条。

| 检查 | 结果 | 实测 |
|---|---|---|
| `sptree-present` | ✅ 通过 | 形状树长度 3465 字符 |
| `shapes-sliced` | ✅ 通过 | 解析出 5 个形状（含组内子形状） |
| `ids-unique` | ✅ 通过 | 5 个 id 全树唯一（含组内子形状） |
| `id-equals-idx-plus-2` | ✅ 通过 | 容器形状满足 pptxgenjs 的 id = idx + 2 规则（补丁器不依赖该规则，仅断言） |
| `connector-exists` | ✅ 通过 | name=dep-1 id=5 |
| `connector-name` | ✅ 通过 | 期望 dep-1，实测 dep-1 |
| `connector-anchors-a-namespace` | ✅ 通过 | stCxn/endCxn 位于 p:nvCxnSpPr > p:cNvCxnSpPr 且为 a: 前缀 |
| `stcxn-target-resolves` | ✅ 通过 | stCxn id=2 → bar-a，期望 bar-a |
| `endcxn-target-resolves` | ✅ 通过 | endCxn id=3 → bar-b，期望 bar-b |
| `stcxn-idx-in-range` | ✅ 通过 | stCxn idx=2，roundRect 合法范围 0..3 |
| `endcxn-idx-in-range` | ✅ 通过 | endCxn idx=0，roundRect 合法范围 0..3 |
| `stcxn-idx-matches-manifest` | ✅ 通过 | stCxn idx=2，manifest 期望 2 |
| `endcxn-idx-matches-manifest` | ✅ 通过 | endCxn idx=0，manifest 期望 0 |
| `connector-no-cxnSpLocks` | ✅ 通过 | 与原生产物一致：未写 cxnSpLocks |
| `connector-prstgeom` | ✅ 通过 | prstGeom=bentConnector3，期望 bentConnector3 |
| `group-exists` | ✅ 通过 | name=grp-1 id=6 |
| `group-name` | ✅ 通过 | 期望 grp-1，实测 grp-1 |
| `group-xfrm-complete` | ✅ 通过 | off=(762000,3937000) ext=cx 2794000 cy 223520；chOff=(0,0) chExt=cx 2500 cy 200 |
| `group-child-space-distinct` | ✅ 通过 | chOff/chExt 与 off/ext 是两套数值，换算公式确实参与 |
| `group-children-count` | ✅ 通过 | 组内子形状 2 个，期望 2 个 |
| `group-children-in-child-space` | ✅ 通过 | 所有子形状坐标落在 chOff/chExt 定义的组坐标系内 |
| `group-absolute-crosscheck` | ✅ 通过 | grp-child-1: 逐值相等; grp-child-2: 逐值相等 |
| `container-slide-size-matches-manifest` | ✅ 通过 | 容器实测 p:sldSz=9144000×5143500 EMU（720×405 pt）；manifest 声明 9144000×5143500 EMU（720×405 pt） |
| `fixture-shapes-in-slide-bounds` | ✅ 通过 | 三个基础形状都在 720×405 pt 幻灯片内（越界形状会渲染到画布外） |
| `group-frame-in-slide-bounds` | ✅ 通过 | 组框 x=762000 y=3937000 cx=2794000 cy=223520；底边 327.6 pt，画布高 405 pt |
| `group-children-in-slide-bounds` | ✅ 通过 | 全部 2 个子形状绝对矩形都在画布内 |
| `connector-points-in-slide-bounds` | ✅ 通过 | 从 (2032000,1346200) 到 (6604000,3048000) |

### group 坐标换算：两条独立路径的交叉验证

| 子形状 | 结果 | 明细 |
|---|---|---|
| grp-child-1 | ✅ 一致 | 逐值相等 |
| grp-child-2 | ✅ 一致 | 逐值相等 |

### group 坐标往返一致性（组坐标 → 绝对 → 组坐标）

| 子形状 | 原始 | 绝对 | 还原 | 结果 |
|---|---|---|---|---|
| grp-child-1 | (0,0) | (762000,3937000) | (0,0) | ✅ |
| grp-child-2 | (1500,0) | (2438400,3937000) | (1500,0) | ✅ |
