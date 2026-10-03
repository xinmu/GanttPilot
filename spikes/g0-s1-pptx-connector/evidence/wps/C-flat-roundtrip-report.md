# S1 · L2 往返存活报告（WPS）

> 由 `pwsh -File src/wps-capture.ps1` 生成。
> **限制**：本机 WPS 12.1.0.28505；WPS 的 COM 自报名称是 "Microsoft PowerPoint"、版本 "12.0"，
> **这是伪装字符串，不得作为「用 Microsoft PowerPoint 验证过」的证据**。
> 按裁决 P-4（2026-10-03），**验证环境以 WPS 为准、Microsoft PowerPoint 备查不阻塞**。
> 本报告只证明「结构经第三方编辑器打开并保存后是否存活」，**不证明「路由渲染正确」**；
> 后者由人工 WPS 真机拖动确认（见 evidence/wps/人工验证记录.md）。

## 逐项判定

| 项 | 结果 |
|---|---|
| 打开无异常 | 通过 |
| 另存副本 | 通过 |
| cxnSp 存活 | 存活（值相同） |
| grpSp 存活 | 存活（值相同） |
| stCxn 存活 | 存活（值相同） |
| endCxn 存活 | 存活（值相同） |
| 形状集合存活 | 存活（值相同） |
| 未引入 cxnSpLocks | WPS 写入 0 处（补丁写 0 处） |

## 结构统计

### 补丁刚写出（未经任何编辑器）

```
cxnSp=1 grpSp=0 stCxn=1 endCxn=1 cxnSpLocks=0
stCxn: id=2 idx=2
endCxn: id=3 idx=0
形状: #1, bar-a#2, bar-b#3, ms-1#4, dep-1#5, grp-child-1#7, grp-child-2#8
```

### WPS 保存后

```
cxnSp=1 grpSp=0 stCxn=1 endCxn=1 cxnSpLocks=0
stCxn: id=2 idx=2
endCxn: id=3 idx=0
形状: #1, bar-a#2, bar-b#3, ms-1#4, dep-1#5, grp-child-1#7, grp-child-2#8
```

## 证据文件

- `evidence/wps/C-flat-as-written.xml`：补丁刚写出的 slide1.xml
- `evidence/wps/C-flat-saved-by-wps.xml`：WPS 另存后的 slide1.xml（可直接 diff 看 WPS 重写了什么）
- `evidence/vision/C-flat-wps-render.png`：WPS 渲染的 slide1（L3 视觉判读输入）
