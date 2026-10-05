# S-G7 · WPS 真机证据链（跨组吸附 / custGeom）

> **迁移说明**：本报告由 G7 准入探针 `spikes/g7-export-probe/src/wps-verify.ps1` 生成
> （该探针目录随 G7 落地删除，证据原样迁到此处，正文不改写）。产品化后的复现入口见
> [`../PPTX.md`](../PPTX.md) 的验证矩阵与 `scripts/wps-pptx-verify.ps1`。
> 由 `pwsh -File src/wps-verify.ps1` 生成。**本报告只覆盖 WPS 引擎**；
> 按裁决 P-4，验证环境以 WPS 为准、Microsoft PowerPoint 备查不阻塞。
> 注意：本机 WPS 的 COM 自报 `Name = "Microsoft PowerPoint"`、`Version = "12.0"`、
> `Build = 12.1.0.28505`——**这是伪装字符串，不得当作"用 Microsoft PowerPoint 验证过"的证据**。

## S7-a：A-cross-group.pptx

| 判据 | 结果 |
|---|---|
| 打开无修复弹窗 | 无修复弹窗（打开成功） |
| WPS 另存成功 | 通过 |
| 被验对象存活 | 存活（stCxn id=5 idx=3、endCxn id=2 idx=2） |
| 对照 connector 存活 | 存活（stCxn id=2 idx=3、endCxn id=3 idx=1） |
| 端点跟随（xfrm 重算） | 通过（xfrm 随移动重算） |
| cxnSpLocks | 补丁写 0 处 / WPS 写 0 处 |

拖动：`L=60 T=60 → L=300 T=120`

形状集合：

```
前：#1, bar-top#2, bar-b#3, grp-1#4, bar-in-group#5, dep-cross-1#6, dep-cross-2#7
后：#1, bar-top#2, bar-b#3, grp-1#4, bar-in-group#5, dep-cross-1#6, dep-cross-2#7
```

| 时点 | off.x | off.y | ext.cx | ext.cy |
|---|---|---|---|---|
| 移动前 | 2032000 | 1219200 | 1270000 | 939800 |
| 移动后 | 3302000 | 1981200 | 1778000 | 177800 |

## S7-b：B-custgeom.pptx

| 判据 | 结果 |
|---|---|
| 打开无修复弹窗 | 无修复弹窗（打开成功） |
| WPS 另存成功 | 通过 |
| 被验对象存活 | custGeom 存活 |
| 对照 connector 存活 | 不适用（本件不含 cxnSp） |
| 端点跟随（xfrm 重算） | 不适用（本件不测跟随） |
| cxnSpLocks | 补丁写 0 处 / WPS 写 0 处 |

拖动：`—`

形状集合：

```
前：#1, bar-a#2, bar-b#3, dep-poly-1#4
后：#1, bar-a#2, bar-b#3, dep-poly-1#4
```

## 证据文件

- `evidence/wps/*-as-written.xml`：补丁刚写出的 slide1.xml
- `evidence/wps/*-saved-by-wps.xml`：WPS 另存后的 slide1.xml（可直接 diff）
- `evidence/vision/*.png`：WPS 渲染图（视觉判读输入，不作定论）
