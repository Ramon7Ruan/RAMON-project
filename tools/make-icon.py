#!/usr/bin/env python3
"""
生成 App 图标（纯标准库，不依赖 Pillow）。

设计：在 macOS 惯例的留白内画一个圆角方块，方块上是三根递增的柱状图 + 一个圆点
—— 表达"知识在积累"。几何、单色、无渐变，保证在 16px 下依然清晰。

产出：build/icon.png（1024）与 build/icon.iconset/*，由 make-icon.sh 调 iconutil 合成 .icns
"""
import math
import os
import struct
import sys
import zlib

BRAND = (47, 111, 176)      # --brand（浅色主题）
WHITE = (255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)

SIZE = 1024
MARGIN = 0.085              # macOS 图标四周留白比例
RADIUS = 0.232              # 圆角半径 / 图标宽度（接近系统 squircle）


def write_png(path, width, height, pixels):
    """pixels: list of rows, each row is a list of (r,g,b,a)"""
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


def rounded_rect_alpha(x, y, x0, y0, x1, y1, r, ss=4):
    """4x4 超采样求覆盖率，得到平滑边缘"""
    inside = 0
    for sy in range(ss):
        for sx in range(ss):
            px = x + (sx + 0.5) / ss
            py = y + (sy + 0.5) / ss
            if px < x0 or px > x1 or py < y0 or py > y1:
                continue
            cx = min(max(px, x0 + r), x1 - r)
            cy = min(max(py, y0 + r), y1 - r)
            if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                inside += 1
    return inside / (ss * ss)


def render(size):
    m = size * MARGIN
    x0, y0, x1, y1 = m, m, size - m, size - m
    r = size * RADIUS
    inner = x1 - x0

    # 三根递增的柱子：居中排布，底部有一条基准线
    bar_w = inner * 0.140
    gap = inner * 0.104
    total = bar_w * 3 + gap * 2
    left = x0 + (inner - total) / 2
    base_y = y0 + inner * 0.775
    heights = [inner * 0.285, inner * 0.440, inner * 0.605]
    bar_r = bar_w * 0.30
    baseline_h = inner * 0.036
    baseline_r = baseline_h / 2

    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            a = rounded_rect_alpha(x, y, x0, y0, x1, y1, r)
            if a <= 0:
                row.append(TRANSPARENT)
                continue

            col = BRAND
            white = 0.0

            for i, h in enumerate(heights):
                bx0 = left + i * (bar_w + gap)
                ca = rounded_rect_alpha(x, y, bx0, base_y - h, bx0 + bar_w, base_y, bar_r, ss=2)
                if ca > white:
                    white = ca

            ca = rounded_rect_alpha(
                x, y, left, base_y + inner * 0.055,
                left + total, base_y + inner * 0.055 + baseline_h, baseline_r, ss=2)
            if ca > white:
                white = ca

            if white > 0:
                col = (
                    round(col[0] * (1 - white) + WHITE[0] * white),
                    round(col[1] * (1 - white) + WHITE[1] * white),
                    round(col[2] * (1 - white) + WHITE[2] * white),
                )

            row.append((col[0], col[1], col[2], 255))
        rows.append(row)
    return rows


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else 'build'
    os.makedirs(out_dir, exist_ok=True)

    icon = render(SIZE)
    write_png(os.path.join(out_dir, 'icon.png'), SIZE, SIZE, icon)
    print(f'wrote {out_dir}/icon.png ({SIZE}x{SIZE})')

    iconset = os.path.join(out_dir, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            suffix = '' if scale == 1 else '@2x'
            name = f'icon_{base}x{base}{suffix}.png'
            write_png(os.path.join(iconset, name), px, px, render(px))
    print(f'wrote {out_dir}/icon.iconset/')


if __name__ == '__main__':
    main()
