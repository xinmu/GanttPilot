# S3 · L1b 独立参照实现差分测试（可重跑、逐字节稳定）

> 由 `node src/differential.mts`（经 `run-all.mts` 调用）生成。参照实现是**独立写法**的 Python 程序
> （`reference/cpm_reference.py`：递归 + `datetime.date` + 显式工作日集合 + DFS 染色检环），
> 与 TS 侧（迭代 + 整数序号 + CSR + Kahn）不共享任何代码，只共享 `manifest.ts` 声明的字段契约。

- 随机 DAG：**1000** 个（5–200 任务、四类关系、lag ∈ [−3, 3]、含 5% 里程碑）；
- 含环图：**200** 个（两侧必须一致报环，其余判定不计入）；
- 日历轮换：默认 Mon–Fri、整周放假、Mon–Sat 三种（按项目序号取模），两侧用各自的日历实现翻译日期；
- 逐字段比对的项目数：**1000**；
- 字段不一致总数：**0**；
- 两侧一致检出成环的图：**200/200**；
- 参照实现脚本体积：8600 字节。

比对字段：`es / ef / ls / lf / totalFloat / freeFloat / critical / projectFinish / esIso / efIso`。
其中 `esIso/efIso` 由两侧**各自的日历实现**翻译，因此这一层同时交叉验证了"工作日序号 ↔ ISO 日期"的语义。

**结论：0 处不一致。**
