#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""G0-S-S3 独立参照实现（差分测试的"另一套实现"）。

**独立写法**：与 TS 侧刻意走不同的路——
- 拓扑与检环用 **DFS 三色染色**（TS 侧是 Kahn 入度法）；
- 前后遍历用 **递归 + 记忆化**（TS 侧是迭代 + 显式拓扑序）；
- 日历用 **`datetime.date` + 显式工作日集合逐日推进**（TS 热路径用整数序号 + 前缀和）；
- 数据结构是普通 `list` / `dict`（TS 侧是 `Int32Array` CSR）。

两侧**只共享字段契约**（见 `src/manifest.ts` 的 `DIFFERENTIAL_FIELDS`），不共享任何代码。

用法（由 `src/differential.mts` 以"文件进出"的方式调用，不走 stdio 管道）：

    python reference/cpm_reference.py <input.json> <output.json>

输入：`{"projects": [{"id", "taskCount", "durations", "links": [{"pred","succ","type","lag"}],
                     "baseDay", "calendar": {"workDays","nonWorking","working"}}]}`
输出：`{"results": [{"id", "hasCycle", "es", "ef", "ls", "lf", "totalFloat", "freeFloat",
                     "critical", "projectFinish", "esIso", "efIso"}]}`

关系类型：`0=FS 1=SS 2=FF 3=SF`；日期维度一律是**工作日序号**（0 = `baseDay` 起的第一个工作日）。
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta

EPOCH = date(1970, 1, 1)
WHITE, GRAY, BLACK = 0, 1, 2

FS, SS, FF, SF = 0, 1, 2, 3


class WorkdayCalendar:
    """逐日推进的工作日历；序号 ↔ `date` 双向映射由 `days` 列表承载。"""

    def __init__(self, base_day: int, work_days, non_working, working):
        self.base_day = base_day
        self.work_days = set(work_days)
        self.non_working = set(non_working)
        self.working = set(working)
        self.days = []  # ordinal -> day number

    def is_workday(self, day: int) -> bool:
        if day in self.non_working:
            return False
        if day in self.working:
            return True
        weekday = (EPOCH + timedelta(days=day)).weekday()  # 0=Mon … 6=Sun
        ooxml_weekday = (weekday + 1) % 7  # 0=Sun … 6=Sat，与 TS 侧 Date#getUTCDay() 对齐
        return ooxml_weekday in self.work_days

    def day_of_ordinal(self, k: int) -> int:
        if k < 0:
            raise ValueError(f"工作日序号越界：{k}")
        if not self.days:
            self.days.append(self.base_day)
            while not self.is_workday(self.days[-1]):
                self.days[-1] += 1
        while len(self.days) <= k:
            cursor = self.days[-1] + 1
            while not self.is_workday(cursor):
                cursor += 1
            self.days.append(cursor)
        return self.days[k]

    def iso_of_ordinal(self, k: int) -> str:
        return (EPOCH + timedelta(days=self.day_of_ordinal(k))).isoformat()


def detect_cycle(task_count: int, successors) -> bool:
    """DFS 三色染色检环（递归，显式提高递归上限）。"""
    color = [WHITE] * task_count

    def visit(node: int) -> bool:
        color[node] = GRAY
        for succ, _kind, _lag in successors[node]:
            if color[succ] == GRAY:
                return True
            if color[succ] == WHITE and visit(succ):
                return True
        color[node] = BLACK
        return False

    for node in range(task_count):
        if color[node] == WHITE and visit(node):
            return True
    return False


def solve(project: dict) -> dict:
    task_count = int(project["taskCount"])
    durations = [int(value) for value in project["durations"]]
    links = project["links"]
    base_day = int(project["baseDay"])
    calendar_spec = project["calendar"]
    calendar = WorkdayCalendar(
        base_day,
        calendar_spec["workDays"],
        calendar_spec["nonWorking"],
        calendar_spec["working"],
    )

    predecessors = [[] for _ in range(task_count)]
    successors = [[] for _ in range(task_count)]
    for link in links:
        pred = int(link["pred"])
        succ = int(link["succ"])
        kind = int(link["type"])
        lag = int(link["lag"])
        if not (0 <= pred < task_count and 0 <= succ < task_count):
            continue
        predecessors[succ].append((pred, kind, lag))
        successors[pred].append((succ, kind, lag))

    if detect_cycle(task_count, successors):
        return {"id": project.get("id"), "hasCycle": True}

    es = [None] * task_count
    ef = [None] * task_count
    ls = [None] * task_count
    lf = [None] * task_count

    def earliest(node: int) -> int:
        if es[node] is not None:
            return es[node]
        es[node] = 0  # 占位（DAG 且无环，不会读到占位值）
        start = 0
        duration = durations[node]
        for pred, kind, lag in predecessors[node]:
            earliest(pred)
            if kind == FS:
                bound = ef[pred] + lag
            elif kind == SS:
                bound = es[pred] + lag
            elif kind == FF:
                bound = ef[pred] + lag - duration
            else:
                bound = es[pred] + lag - duration
            if bound > start:
                start = bound
        if start < 0:
            start = 0
        es[node] = start
        ef[node] = start + duration
        return start

    for node in range(task_count):
        earliest(node)

    finish = max(ef) if task_count > 0 else 0

    def latest(node: int) -> int:
        if ls[node] is not None:
            return ls[node]
        duration = durations[node]
        ls[node] = finish - duration
        best = finish - duration
        if successors[node]:
            best = None
            for succ, kind, lag in successors[node]:
                latest(succ)
                if kind == FS:
                    bound = ls[succ] - lag - duration
                elif kind == SS:
                    bound = ls[succ] - lag
                elif kind == FF:
                    bound = ls[succ] + durations[succ] - lag - duration
                else:
                    bound = ls[succ] + durations[succ] - lag
                if best is None or bound < best:
                    best = bound
        ls[node] = best
        lf[node] = best + duration
        return best

    for node in range(task_count):
        latest(node)

    total_float = []
    free_float = []
    critical = []
    for node in range(task_count):
        total_float.append(ls[node] - es[node])
        critical.append(1 if ls[node] == es[node] else 0)
        if not successors[node]:
            free_float.append(finish - ef[node])
        else:
            best = None
            for succ, kind, lag in successors[node]:
                if kind == FS:
                    slack = es[succ] - ef[node] - lag
                elif kind == SS:
                    slack = es[succ] - es[node] - lag
                elif kind == FF:
                    slack = ef[succ] - ef[node] - lag
                else:
                    slack = ef[succ] - es[node] - lag
                if best is None or slack < best:
                    best = slack
            free_float.append(best)

    return {
        "id": project.get("id"),
        "hasCycle": False,
        "es": es,
        "ef": ef,
        "ls": ls,
        "lf": lf,
        "totalFloat": total_float,
        "freeFloat": free_float,
        "critical": critical,
        "projectFinish": finish,
        "esIso": [calendar.iso_of_ordinal(value) for value in es],
        "efIso": [calendar.iso_of_ordinal(value) for value in ef],
    }


def main(argv) -> int:
    if len(argv) != 3:
        print("用法：python reference/cpm_reference.py <input.json> <output.json>", file=sys.stderr)
        return 2
    try:  # Windows 控制台默认 GBK，会把中文日志打成乱码；显式切到 UTF-8。
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    with open(argv[1], "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    projects = payload["projects"]
    # 深链（最长 200）用递归实现：显式提高递归上限，避免默认 1,000 层在深链上触顶。
    sys.setrecursionlimit(200_000)
    results = [solve(project) for project in projects]
    with open(argv[2], "w", encoding="utf-8", newline="\n") as handle:
        json.dump({"results": results}, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    print(f"[reference] 处理 {len(results)} 个项目 → {argv[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
