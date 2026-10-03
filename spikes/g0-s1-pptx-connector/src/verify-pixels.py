#!/usr/bin/env python
"""L3 辅助判读：用像素量化「connector 端点是否真正贴在目标形状边上」。

**定位：侧证，不是门禁。** 主证据是视觉判读（见 evidence/vision/判读记录.md）；
本脚本把「看起来贴住了」变成可量化的距离，降低误判风险。

实现要点：**按连通域分组**再取包围盒，而不是「所有同色像素的包围盒」。
后者会把画面上互不相连的同色像素（例如边框/主题色阴影）混进同一个包围盒，
产生远大于真实形状的框——实测 `bar-a` 因此被量成 490×572 px（真实约 443×79）。
连通域还顺带过滤掉小于面积阈值的噪点。

用法：
  python src/verify-pixels.py <png>
输出为可粘贴进判读记录的 Markdown 表格。
"""

from __future__ import annotations

import sys
from collections import deque

from PIL import Image

# 形状填充色 → 名称（与 manifest.ts 的声明一致）
FILL_COLORS = {
    (46, 117, 182): "bar-a",
    (192, 0, 0): "bar-b",
    (237, 125, 49): "ms-1",
    (112, 48, 160): "grp-child-1",
    (0, 176, 240): "grp-child-2",
}

# 连线颜色（a:srgbClr val="00B050"）
LINE_COLOR = (0, 176, 80)
COLOR_TOLERANCE = 40
# 连通域面积阈值：低于此值视为噪点/抗锯齿边缘
MIN_COMPONENT_AREA = 500


def close(pixel: tuple[int, int, int], target: tuple[int, int, int]) -> bool:
    return all(abs(pixel[i] - target[i]) <= COLOR_TOLERANCE for i in range(3))


def components_of(
    pixels: list[list[tuple[int, int, int]]], target: tuple[int, int, int]
) -> list[dict[str, int]]:
    """返回该颜色的所有连通域（4 邻接）及其包围盒，按面积降序。"""
    h = len(pixels)
    w = len(pixels[0])
    seen = [[False] * w for _ in range(h)]
    out: list[dict[str, int]] = []

    for y0 in range(h):
        for x0 in range(w):
            if seen[y0][x0] or not close(pixels[y0][x0], target):
                continue
            queue = deque([(x0, y0)])
            seen[y0][x0] = True
            min_x = max_x = x0
            min_y = max_y = y0
            area = 0
            while queue:
                x, y = queue.popleft()
                area += 1
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and close(pixels[ny][nx], target):
                        seen[ny][nx] = True
                        queue.append((nx, ny))
            if area >= MIN_COMPONENT_AREA:
                out.append(
                    {
                        "x": min_x,
                        "y": min_y,
                        "cx": max_x - min_x + 1,
                        "cy": max_y - min_y + 1,
                        "area": area,
                    }
                )
    out.sort(key=lambda c: c["area"], reverse=True)
    return out


def line_pixels(pixels: list[list[tuple[int, int, int]]]) -> list[tuple[int, int]]:
    h = len(pixels)
    w = len(pixels[0])
    return [(x, y) for y in range(h) for x in range(w) if close(pixels[y][x], LINE_COLOR)]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    img = Image.open(path).convert("RGB")
    w, h = img.size
    px = img.load()
    if px is None:
        raise SystemExit("无法读取像素")
    pixels = [[px[x, y] for x in range(w)] for y in range(h)]
    print(f"# 像素量化：`{path}`（{w}×{h} px）")

    print("\n## 形状连通域包围盒（按面积取最大者）")
    print("| 名称 | 左 | 上 | 宽 | 高 | 面积(px) | 连通域个数 |")
    print("|---|---|---|---|---|---|---|")
    boxes: dict[str, dict[str, int]] = {}
    for color, name in FILL_COLORS.items():
        comps = components_of(pixels, color)
        if not comps:
            print(f"| {name} | — | — | — | — | 0 | 0（未找到） |")
            continue
        main_box = comps[0]
        boxes[name] = main_box
        print(
            f"| {name} | {main_box['x']} | {main_box['y']} | {main_box['cx']} | {main_box['cy']} | {main_box['area']} | {len(comps)} |"
        )

    line = line_pixels(pixels)
    print(f"\n连线颜色像素数：{len(line)}")
    if not line:
        print("**未找到连线颜色像素**——连线可能未渲染，或颜色与 `00B050` 不符。")
        return 0
    lx = [p[0] for p in line]
    ly = [p[1] for p in line]
    print(f"连线包围盒：x {min(lx)}..{max(lx)}，y {min(ly)}..{max(ly)}")

    print("\n## 连线与各形状的贴合度")
    print("| 形状 | 最近距离(px) | 形状尺寸(px) | 判定 |")
    print("|---|---|---|---|")
    for name, box in boxes.items():
        best = 10**9
        for (x, y) in line:
            dx = max(box["x"] - x, 0, x - (box["x"] + box["cx"] - 1))
            dy = max(box["y"] - y, 0, y - (box["y"] + box["cy"] - 1))
            best = min(best, (dx * dx + dy * dy) ** 0.5)
        # 连线本身有 2~3px 线宽；阈值再放宽到短边的 10%
        threshold = max(3.0, min(box["cx"], box["cy"]) * 0.10)
        verdict = "贴合（端点落在形状边上）" if best <= threshold else "**未贴合**"
        print(f"| {name} | {best:.1f} | {box['cx']}×{box['cy']} | {verdict} |")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
