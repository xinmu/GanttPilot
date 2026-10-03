# S1 · L4 自动化拖动实验报告（WPS）

> 由 `pwsh -File src/wps-drag.ps1` 生成。
> 注意：本报告是 WPS 引擎的结论。**按裁决 P-4（2026-10-03），验证环境以 WPS 为准、
> Microsoft PowerPoint 备查不阻塞**；L4 的结果已与人工 WPS 真机拖动结果互相印证
> （见 evidence/wps/人工验证记录.md）。PowerPoint 未验证，产品不对外承诺其下行为。
> 判别力依据：WPS 原生连接符已实测会跟随形状移动，因此"不跟随"可归因于补丁形态而非工具能力缺失。

## 拖动操作

- 页面尺寸：720 × 405 pt
- 移动对象：`bar-b`，L=420 T=240 → L=300 T=280

## 逐项判定

| 判据 | 结果 |
|---|---|
| 结构存活（stCxn/endCxn/cxnSp 各 1） | 通过 |
| 走线改道（xfrm 随移动重算） | 通过 |
| 端点仍吸附（已人工确认） | 通过：人工在 WPS 真机拖动确认端点跟随，且与本次自动化结果一致（见 evidence/wps/人工验证记录.md） |

## connector 几何对比（EMU）

| 时点 | off.x | off.y | ext.cx | ext.cy | xfrm 属性 |
|---|---|---|---|---|---|
| 移动前 | 2032000 | 1346200 | 4572000 | 1701800 | `` |
| 移动后 | 2451100 | 927100 | 2209800 | 3048000 | `rot="5400000" flipV="1"` |

## 吸附锚点对比

### 移动前

```
cxnSp=1 grpSp=1 stCxn=1 endCxn=1 cxnSpLocks=0
stCxn: id=2 idx=2
endCxn: id=3 idx=0
形状: #1, bar-a#2, bar-b#3, ms-1#4, dep-1#5, grp-1#6, grp-child-1#7, grp-child-2#8
```

### 移动后

```
cxnSp=1 grpSp=1 stCxn=1 endCxn=1 cxnSpLocks=0
stCxn: id=2 idx=2
endCxn: id=3 idx=0
形状: #1, bar-a#2, bar-b#3, ms-1#4, dep-1#5, grp-1#6, grp-child-1#7, grp-child-2#8
```

## 证据文件

- `evidence/vision/A-drag-before.png` / `A-drag-after.png`：拖动前后渲染图（**视觉判读的输入**）
- `evidence/wps/A-drag-before.xml` / `A-after-drag.xml`：拖动前后的 slide1.xml
