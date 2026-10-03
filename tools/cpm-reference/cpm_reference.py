#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GanttPilot 排程内核的**独立参照实现**（差分 oracle，零第三方依赖）。

用法::

    python cpm_reference.py <input.json> <output.json>

这是 ``packages/engine/src/schedule.ts`` 的**另一种写法**，不是移植：它与 TS 侧只共享
``packages/engine/SCHEDULE.md`` 声明的字段与语义契约（协议见同目录 ``README.md``），
不共享任何一行代码。

刻意的实现差异（见 README §一）：

* 日期承载：``datetime.date`` + 显式工作日集合，**逐日推进**（TS 侧是整数日序号 + 前缀和索引）；
* 图算法：**DFS 三色染色**检环（TS 侧是 Kahn 入度法）；
* 正向传播：**递归 + 记忆化**（TS 侧是 CSR 拓扑序迭代）；
* 数据结构：``list`` / ``dict`` / ``set``（TS 侧是 CSR + 类型化数组）。

依赖：仅标准库 ``json`` / ``sys`` / ``datetime``。
确定性：同一输入 → **逐字节相同**的输出（诊断顺序：任务级按文档序、边级按 link 序、锚点按输入序）。
"""

import sys
import json
from datetime import date, timedelta

# 深链必须显式提高递归上限（S3 的先例：200,000）。必须在任何递归之前设置。
sys.setrecursionlimit(200000)

# ------------------------------------------------------------------ 常量

#: 排程侧诊断码闭集（SCHEDULE.md §六；`cycle` 不出现在结果诊断里）。
CODES = (
    "undated",
    "dateOverridden",
    "clampedStart",
    "anchorConflict",
    "anchorUnknown",
    "summaryIgnored",
    "endDateStale",
    "constraintsUnused",
)

#: 哨兵：汇总任务在 `es` / `ef` 里放 -1，叶子在 `summary*` 里放 -1。
LEAF_SENTINEL = -1

#: 缺省工作日：周一至周五（0=周日 … 6=周六）。**必须与 date.ts 的 DEFAULT_WORK_DAYS 一致**。
DEFAULT_WORK_DAYS = frozenset((1, 2, 3, 4, 5))

_ONE_DAY = timedelta(days=1)


# ------------------------------------------------------------------ 标量谓词

def _is_int(value):
    """有限整数（``bool`` 是 ``int`` 的子类，必须排除）。"""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_finite_number(value):
    """有限数值（``bool`` 是 ``int`` 的子类，必须排除）。"""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    return value == value and value not in (float("inf"), float("-inf"))


def _is_iso_date_string(value):
    """严格 ``YYYY-MM-DD``（与 ``isoToDayNumber`` 同口径：只认 4-2-2 数字形态）。"""
    if not isinstance(value, str) or len(value) != 10:
        return False
    if value[4] != "-" or value[7] != "-":
        return False
    for index, expected in ((0, 4), (5, 2), (8, 2)):
        chunk = value[index:index + expected]
        if not chunk.isdigit() or not chunk.isascii():
            return False
    return True


def _is_date_value(value):
    """非空且可解析的 ISO 日期（用于工期解析与 `endDateStale` 判定）。"""
    if not _is_iso_date_string(value):
        return False
    try:
        _parse_iso(value)
    except ValueError:
        return False
    return True


def _parse_iso(iso):
    """``YYYY-MM-DD`` → ``datetime.date``。"""
    return date(int(iso[0:4]), int(iso[5:7]), int(iso[8:10]))


def _iso_of(day):
    return day.isoformat()


# ------------------------------------------------------------------ 日历（逐日推进）

class DayCalendar(object):
    """工作日历：``datetime.date`` + 显式工作日集合，逐日推进。

    * ``is_workday(d)`` = 「非工作日例外」优先，其次「工作日例外」，最后周内规则；
    * ``ordinal_of_day(d)`` = ``[base, d)`` 内的工作日数（``d`` 早于 ``base`` → ``0``）；
    * ``day_of_ordinal(k)`` = 从 ``base`` 起逐日推进，数到第 ``k`` 个工作日（0 基）；
      越界时继续向后推进到首个工作日——语义是「最后一个工作日之后的**首个工作日**」
      （与 ``Calendar.dayOfOrdinal`` 的排他结束日口径一致）。

    这里**刻意逐日扫描**：参照实现走可读可审计的路，不复制 TS 侧的前缀和索引。
    """

    __slots__ = ("base", "_work_days", "_non_working", "_working", "_ordinal_cache", "_day_cache")

    def __init__(self, base, work_days, non_working, working):
        self.base = base
        self._work_days = work_days
        self._non_working = non_working
        self._working = working
        self._ordinal_cache = {}
        self._day_cache = {}

    def is_workday(self, day):
        if day in self._non_working:
            return False
        if day in self._working:
            return True
        # ``date.weekday()``: 周一=0 … 周日=6；本仓库口径: 周日=0 … 周六=6。
        return ((day.weekday() + 1) % 7) in self._work_days

    def ordinal_of_day(self, day):
        cached = self._ordinal_cache.get(day)
        if cached is not None:
            return cached
        base = self.base
        if day <= base:
            # 早于 baseDay（或恰为 baseDay）→ 序号 0（负数序号无定义）。
            self._ordinal_cache[day] = 0
            return 0
        span = (day - base).days
        count = 0
        cursor = base
        for _ in range(span):
            if self.is_workday(cursor):
                count += 1
            cursor += _ONE_DAY
        self._ordinal_cache[day] = count
        return count

    def day_of_ordinal(self, ordinal):
        cached = self._day_cache.get(ordinal)
        if cached is not None:
            return cached
        cursor = self.base
        remaining = ordinal
        while True:
            if self.is_workday(cursor):
                if remaining == 0:
                    break
                remaining -= 1
            cursor += _ONE_DAY
        self._day_cache[ordinal] = cursor
        return cursor

    def workdays_between(self, start_day, end_day_exclusive):
        """半开区间 ``[start_day, end_day_exclusive)`` 内的工作日数；倒置/空区间 → 0。"""
        if end_day_exclusive <= start_day:
            return 0
        return self.ordinal_of_day(end_day_exclusive) - self.ordinal_of_day(start_day)

    def iso_of_ordinal(self, ordinal):
        return _iso_of(self.day_of_ordinal(ordinal))


def _build_calendar(calendar_spec, base_day):
    """从输入协议的 ``calendar`` 块构造 :class:`DayCalendar`（缺省=周一至周五）。"""
    spec = calendar_spec if isinstance(calendar_spec, dict) else {}

    raw_work_days = spec.get("workDays")
    work_days = set()
    if isinstance(raw_work_days, list):
        for candidate in raw_work_days:
            if _is_int(candidate) and 0 <= candidate <= 6:
                work_days.add(candidate)
    if not work_days:
        work_days = set(DEFAULT_WORK_DAYS)

    def compile_days(key):
        """收集例外日。

        规范形状是**文档的 `CalendarSpec`**（例外嵌在 `exceptions` 里）；
        同时容忍 S3 口径的扁平形状（`nonWorking`/`working` 直接挂在日历块上），
        因为 README 早期版本就是这么写的。两侧以 `exceptions` 优先。
        """
        days = set()
        containers = []
        exceptions = spec.get("exceptions")
        if isinstance(exceptions, dict):
            containers.append(exceptions)
        containers.append(spec)
        for container in containers:
            raw = container.get(key)
            if not isinstance(raw, list):
                continue
            for candidate in raw:
                if _is_iso_date_string(candidate):
                    try:
                        days.add(_parse_iso(candidate))
                    except ValueError:
                        continue
        return days

    non_working = compile_days("nonWorking")
    # 同日冲突时**非工作日优先**：命中 nonWorking 的日期从 working 里剔除。
    working = compile_days("working") - non_working
    return DayCalendar(base_day, frozenset(work_days), frozenset(non_working), frozenset(working))


# ------------------------------------------------------------------ 诊断

class Diagnostics(object):
    """按确定顺序收集诊断条目。

    输出形状严格是 ``{code, taskId, linkId}`` 三项（README §三 的样例形状）；
    不适用的一项写 ``null``——排序与比对只依赖这三项。
    """

    __slots__ = ("_items",)

    def __init__(self):
        self._items = []

    def add(self, code, task_id=None, link_id=None):
        self._items.append({"code": code, "taskId": task_id, "linkId": link_id})

    def items(self):
        return self._items


# ------------------------------------------------------------------ 单项目排程

def schedule_project(project):
    """对一个项目求解，返回输出协议里的一条 ``results`` 条目。"""
    project_id = project.get("id")
    diagnostics = Diagnostics()

    # ---- 输入解析（全部容错；非法项按"未提供"处理）----
    raw_tasks = project.get("tasks")
    tasks = raw_tasks if isinstance(raw_tasks, list) else []
    raw_links = project.get("links")
    links = raw_links if isinstance(raw_links, list) else []
    raw_anchors = project.get("anchors")
    anchors = raw_anchors if isinstance(raw_anchors, list) else []

    # 任务 id → 文档序下标。重复 id 取**首次**出现，保持索引确定性。
    index_of_task = {}
    for position, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        task_id = task.get("id")
        if isinstance(task_id, str) and task_id not in index_of_task:
            index_of_task[task_id] = position

    # 汇总任务 = 有子任务的任务（唯一需要收集的信息就是"谁是别人的父"）。
    summary_flags = [False] * len(tasks)
    for task in tasks:
        if not isinstance(task, dict):
            continue
        parent_id = task.get("parentId")
        if isinstance(parent_id, str) and parent_id in index_of_task:
            summary_flags[index_of_task[parent_id]] = True

    # ---- 序号空间与项目起点三级回落（SCHEDULE.md §四.5）----
    raw_base_day = project.get("baseDay")
    if _is_int(raw_base_day):
        base_day = date(1970, 1, 1) + timedelta(days=raw_base_day)
    else:
        # 协议要求 baseDay 存在；缺失时兜底到 1970-01-01（序号即 UTC 日序号）。
        base_day = date(1970, 1, 1)
    calendar = _build_calendar(project.get("calendar"), base_day)

    clamped_starts = 0

    def ordinal_of_iso(iso, task_id=None):
        """ISO → 工作日序号；早于 ``baseDay`` 的日期按 0 计，**既计数又报一条** ``clampedStart``。

        与 TS 侧同源：``clampedStarts`` 必须恒等于 ``clampedStart`` 诊断条数
        （SCHEDULE.md §六的不变量），因此这里计数与诊断成对出现。
        """
        nonlocal clamped_starts
        try:
            day = _parse_iso(iso)
        except ValueError:
            return None
        if day < base_day:
            clamped_starts += 1
            diagnostics.add("clampedStart", task_id=task_id)
            return 0
        return calendar.ordinal_of_day(day)

    # 每个任务解析后的 ``startDate`` 序号（None = 无日期/非法日期）。
    task_start_ordinals = [None] * len(tasks)
    for position, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        start_iso = task.get("startDate")
        if _is_iso_date_string(start_iso):
            task_start_ordinals[position] = ordinal_of_iso(start_iso, task.get("id"))

    project_start_iso = project.get("projectStartDate")
    if _is_iso_date_string(project_start_iso):
        project_start = ordinal_of_iso(project_start_iso)
        if project_start is None:
            # `YYYY-MM-DD` 形态合法但日历上不存在（如 2026-02-30）：回落到下一级。
            project_start = None
    else:
        project_start = None

    if project_start is None:
        # 第②级：全部非空 ``task.startDate`` 的序号最小值（会话锚点**不参与**）。
        known = [value for value in task_start_ordinals if value is not None]
        project_start = min(known) if known else 0

    # ---- 锚点分类（SCHEDULE.md §四.3 健壮性表）----
    # 先按输入序校验并收集诊断，再让"后者胜"决定最终生效值。
    session_anchor = {}
    for anchor in anchors:
        if not isinstance(anchor, dict):
            diagnostics.add("anchorUnknown", task_id=None)
            continue
        anchor_task_id = anchor.get("taskId")
        anchor_ordinal = anchor.get("startOrdinal")
        position = index_of_task.get(anchor_task_id) if isinstance(anchor_task_id, str) else None
        if position is None:
            # 未知 taskId：忽略 + anchorUnknown。
            diagnostics.add("anchorUnknown", task_id=anchor_task_id if isinstance(anchor_task_id, str) else None)
            continue
        if summary_flags[position]:
            # 指向汇总任务：忽略 + summaryIgnored（附带 taskId）。
            diagnostics.add("summaryIgnored", task_id=anchor_task_id)
            continue
        if not _is_int(anchor_ordinal):
            # 非有限整数序号：忽略 + anchorUnknown（顺序对齐 SCHEDULE.md §四.3 的健壮性表：
            # 未知 taskId → 汇总任务 → 非整数序号）。
            diagnostics.add("anchorUnknown", task_id=anchor_task_id)
            continue
        # 同一任务重复给出 → 后者胜（会话里最后一次拖动才是用户意图）。
        session_anchor[position] = anchor_ordinal

    # ---- 图的两种口径：检环用**全部边**，传播排除汇总端点边（SCHEDULE.md §四.6）----
    outgoing = {}
    incoming = {}
    for position in range(len(tasks)):
        outgoing[position] = []
        incoming[position] = []

    active_links = []  # (link_index, link_id, from_pos, to_pos, kind, lag)
    for link_index, link in enumerate(links):
        if not isinstance(link, dict):
            continue
        link_id = link.get("id")
        from_id = link.get("from")
        to_id = link.get("to")
        kind = link.get("type")
        lag = link.get("lagDays")
        from_pos = index_of_task.get(from_id) if isinstance(from_id, str) else None
        to_pos = index_of_task.get(to_id) if isinstance(to_id, str) else None
        # 悬空/不可解析的边：**忽略且不报告**（SCHEDULE.md §六 的闭集码表）。
        if from_pos is None or to_pos is None:
            continue
        if lag is None:
            lag = 0
        if not _is_int(lag):
            continue
        if kind not in ("FS", "SS", "FF", "SF"):
            continue
        active_links.append((link_index, link_id, from_pos, to_pos, kind, lag))
        outgoing[from_pos].append((to_pos, kind, lag))
        incoming[to_pos].append((from_pos, kind, lag))

    # ---- 检环：DFS 三色染色（递归），结构性覆盖全部边 ----
    WHITE, GREY, BLACK = 0, 1, 2
    colors = [WHITE] * len(tasks)
    cyclic = False

    def walk(node):
        """返回 True 表示从 ``node`` 出发发现了环。"""
        colors[node] = GREY
        for successor, _kind, _lag in outgoing[node]:
            color = colors[successor]
            if color == GREY:
                return True
            if color == WHITE and walk(successor):
                return True
        colors[node] = BLACK
        return False

    for start in range(len(tasks)):
        if colors[start] == WHITE and walk(start):
            cyclic = True
            break

    if cyclic:
        # 成环图只输出 ``{"id", "hasCycle": true}``（两侧都不产出排程）。
        return {"id": project_id, "hasCycle": True}

    # ---- 工期解析（SCHEDULE.md §四.2）与 ``endDateStale`` ----
    durations = [0] * len(tasks)
    end_stale = [False] * len(tasks)

    for position, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        duration = task.get("durationDays")
        if _is_finite_number(duration):
            durations[position] = int(duration)
        else:
            start_iso = task.get("startDate")
            end_iso = task.get("endDate")
            if _is_date_value(start_iso) and _is_date_value(end_iso):
                durations[position] = calendar.workdays_between(_parse_iso(start_iso), _parse_iso(end_iso))

        # ``endDate`` 是派生显示值：三者齐备而 workdaysBetween(start, end) !== durationDays
        # 时给 info 级 ``endDateStale``（不报错、不改写文档）。
        if (
            _is_finite_number(duration)
            and _is_date_value(task.get("startDate"))
            and _is_date_value(task.get("endDate"))
        ):
            derived = calendar.workdays_between(
                _parse_iso(task.get("startDate")), _parse_iso(task.get("endDate"))
            )
            if derived != int(duration):
                end_stale[position] = True

    # ---- 正向传播：递归 + 记忆化（有环已在上面被拒，故递归必然终止）----
    es = [LEAF_SENTINEL] * len(tasks)
    ef = [LEAF_SENTINEL] * len(tasks)
    anchored = [0] * len(tasks)
    driven = [0] * len(tasks)
    resolved = [False] * len(tasks)

    def resolve(position):
        """递归求解第 ``position`` 个**叶子**任务的 (es, ef)；结果写在 es/ef 里。"""
        nonlocal clamped_starts
        if resolved[position]:
            return
        task = tasks[position]

        # 有效入边 = 排除任一端点为汇总任务的边。
        effective = []
        for from_pos, kind, lag in incoming[position]:
            if summary_flags[from_pos] or summary_flags[position]:
                continue
            effective.append((from_pos, kind, lag))

        if not effective:
            # 情形①②：无有效入边 → 文档日期序号 ?? 项目起点；锚点若存在则用它。
            document_ordinal = task_start_ordinals[position]
            resolved_document = document_ordinal if document_ordinal is not None else project_start
            anchor = session_anchor.get(position)
            if anchor is not None:
                raw = anchor
                anchored[position] = 1
            else:
                raw = resolved_document
                anchored[position] = 1
                if document_ordinal is None:
                    diagnostics.add("undated", task_id=task.get("id"))
            start = raw
            if start < project_start:
                start = project_start
                clamped_starts += 1
                diagnostics.add("clampedStart", task_id=task.get("id"))
            es[position] = start
            ef[position] = start + durations[position]
            resolved[position] = True
            return

        # 情形③④：有有效入边 —— 先求全部前驱，再取约束最大值。
        raw = None
        for from_pos, kind, lag in effective:
            if not resolved[from_pos]:
                resolve(from_pos)
            predecessor_es = es[from_pos]
            predecessor_ef = ef[from_pos]
            if kind == "FS":
                constraint = predecessor_ef + lag
            elif kind == "SS":
                constraint = predecessor_es + lag
            elif kind == "FF":
                constraint = predecessor_ef + lag - durations[position]
            else:  # SF
                constraint = predecessor_es + lag - durations[position]
            if raw is None or constraint > raw:
                raw = constraint

        anchor = session_anchor.get(position)
        if anchor is not None:
            # 情形④：ES = max(锚定序号, 全部入边约束)；锚定更早 → anchorConflict。
            if anchor < raw:
                diagnostics.add("anchorConflict", task_id=task.get("id"))
            if anchor > raw:
                raw = anchor
            anchored[position] = 1
        else:
            # 情形③：文档日期被忽略；与**最终 ES（含项目起点截断）**不同则 driven=1 且
            # dateOverridden —— 与 TS 侧 `driven` 的定义同源（"文档日期被推导覆盖"）。
            document_ordinal = task_start_ordinals[position]
            start = raw
            if start < project_start:
                start = project_start
                clamped_starts += 1
                diagnostics.add("clampedStart", task_id=task.get("id"))
            if document_ordinal is not None and document_ordinal != start:
                driven[position] = 1
                diagnostics.add("dateOverridden", task_id=task.get("id"))
            es[position] = start
            ef[position] = start + durations[position]
            resolved[position] = True
            return

        start = raw
        if start < project_start:
            start = project_start
            clamped_starts += 1
            diagnostics.add("clampedStart", task_id=task.get("id"))
        es[position] = start
        ef[position] = start + durations[position]
        resolved[position] = True

    for start_node in range(len(tasks)):
        if summary_flags[start_node]:
            continue
        resolve(start_node)

    leaves = [position for position in range(len(tasks)) if not summary_flags[position]]

    # ---- 汇总聚合：按文档序解析祖先链（父必先于子出现），子树内叶子直接判定 ----
    subtree_leaves = [[] for _ in range(len(tasks))]
    for position in leaves:
        parent_id = tasks[position].get("parentId") if isinstance(tasks[position], dict) else None
        ancestor = index_of_task.get(parent_id) if isinstance(parent_id, str) else None
        # 沿 parentId 上溯到根；``seen`` 兜底非法文档里的自引用/环。
        seen = set()
        while ancestor is not None and ancestor not in seen:
            seen.add(ancestor)
            subtree_leaves[ancestor].append(position)
            grand = tasks[ancestor].get("parentId") if isinstance(tasks[ancestor], dict) else None
            ancestor = index_of_task.get(grand) if isinstance(grand, str) else None

    summary_es = [LEAF_SENTINEL] * len(tasks)
    summary_ef = [LEAF_SENTINEL] * len(tasks)
    summary_progress = [LEAF_SENTINEL] * len(tasks)

    for position in range(len(tasks)):
        if not summary_flags[position]:
            continue
        members = subtree_leaves[position]
        if not members:
            # 汇总任务一定有叶子；全汇总子树（非法文档）时保持 -1，不产出 NaN 序号。
            continue
        summary_es[position] = min(es[member] for member in members)
        summary_ef[position] = max(ef[member] for member in members)
        weight_sum = 0
        weighted = 0
        for member in members:
            duration = durations[member]
            # ``progress === null`` → p̃ = 0，但**照常计入分母**（d 仍累加）。
            progress = 0.0
            raw_progress = tasks[member].get("progress") if isinstance(tasks[member], dict) else None
            if _is_finite_number(raw_progress):
                progress = float(raw_progress)
            weight_sum += duration
            weighted += duration * progress
        if weight_sum == 0:
            # Σdᵢ === 0 → NaN（输出时必须序列化成 null）。
            summary_progress[position] = None
        else:
            summary_progress[position] = weighted / weight_sum

    # ---- 里程碑、项目起止 ----
    milestone_count = 0
    for position in leaves:
        task = tasks[position] if isinstance(tasks[position], dict) else {}
        if task.get("milestone") is True:
            milestone_count += 1
            continue
        raw_duration = task.get("durationDays")
        # 用**字段值**而非解析工期：否则"无日期无工期"的占位叶子会被误计为里程碑。
        if _is_int(raw_duration) and raw_duration == 0:
            milestone_count += 1

    if leaves:
        project_finish = max(ef[position] for position in leaves)
    else:
        project_finish = project_start

    # ---- 边级诊断：汇总端点边被传播忽略，按 link 序报告 ----
    for _link_index, link_id, from_pos, to_pos, _kind, _lag in active_links:
        if summary_flags[from_pos] or summary_flags[to_pos]:
            diagnostics.add("summaryIgnored", link_id=link_id)

    # ---- 任务级留位字段诊断（按文档序）----
    for position, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        task_id = task.get("id")
        if end_stale[position]:
            diagnostics.add("endDateStale", task_id=task_id)
        raw_constraints = task.get("constraints")
        if (isinstance(raw_constraints, list) and len(raw_constraints) > 0) or task.get("manual") is True:
            diagnostics.add("constraintsUnused", task_id=task_id)

    # ---- ISO 翻译：汇总行（es < 0）写 null ----
    es_iso = []
    ef_iso = []
    for position in range(len(tasks)):
        if es[position] < 0:
            es_iso.append(None)
        else:
            es_iso.append(calendar.iso_of_ordinal(es[position]))
        if ef[position] < 0:
            ef_iso.append(None)
        else:
            ef_iso.append(calendar.iso_of_ordinal(ef[position]))

    return {
        "id": project_id,
        "hasCycle": False,
        "taskCount": len(tasks),
        "es": es,
        "ef": ef,
        "anchored": anchored,
        "driven": driven,
        "summaryEs": summary_es,
        "summaryEf": summary_ef,
        "summaryProgress": summary_progress,
        "milestoneCount": milestone_count,
        "projectStart": project_start,
        "projectFinish": project_finish,
        "clampedStarts": clamped_starts,
        "esIso": es_iso,
        "efIso": ef_iso,
        "diagnostics": diagnostics.items(),
    }


# ------------------------------------------------------------------ 入口

USAGE = "usage: cpm_reference.py <input.json> <output.json>"


def _read_input(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_output(path, payload):
    """写 UTF-8 JSON，末尾换行；``newline="\\n"`` 让输出逐字节跨平台一致。

    分隔符用紧凑形态（README §三 明确允许 ``, `` 或 ``:``；紧凑与仓库既有的
    ``spikes/g0-s3-cpm-perf/reference/cpm_reference.py`` 同口径）。
    """
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")


def run(input_path, output_path):
    """读取输入、逐项目求解、写出输出。"""
    payload = _read_input(input_path)
    raw_projects = payload.get("projects") if isinstance(payload, dict) else None
    projects = raw_projects if isinstance(raw_projects, list) else []
    results = [schedule_project(project if isinstance(project, dict) else {}) for project in projects]
    _write_output(output_path, {"results": results})


def main(argv):
    # Windows 控制台默认 GBK：先把 stdout/stderr 切成 UTF-8，中文诊断才不会打成乱码。
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except (ValueError, OSError):  # pragma: no cover - 非交互流可能不支持
                pass

    if len(argv) != 3:
        print(USAGE, file=sys.stderr)
        return 2
    try:
        run(argv[1], argv[2])
    except Exception as error:  # noqa: BLE001 - 参照实现自身出错 → 非 0 退出（差分判失败）
        print("cpm_reference: {0}: {1}".format(type(error).__name__, error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
