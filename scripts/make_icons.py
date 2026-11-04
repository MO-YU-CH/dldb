"""DLsite Coupon Plus 图标生成器。

纯标准库实现：按几何形状逐像素渲染 + 4x 超采样抗锯齿 + 自写 PNG 编码。
不依赖 Pillow，保证在任何 Python 3.9+ 环境可复现构建。

用法：
    python scripts/make_icons.py
产物：
    extension/icons/icon-48.png / icon-96.png / icon-128.png
"""

import math
import os
import struct
import zlib

SS = 4  # 超采样倍数

BG = (0x12, 0x12, 0x1F)      # 深底
TICKET = (0xFF, 0xD1, 0x66)  # 券面（琥珀）
ARROW = (0x16, 0x16, 0x29)   # 券面内的箭头（深色，与底同族）

# 128x128 设计稿坐标
BG_BOX = (2, 2, 126, 126, 26)
TICKET_BOX = (22, 46, 106, 90, 8)
NOTCH_L = (22, 68, 7)
NOTCH_R = (106, 68, 7)
ARROW_SHAFT = (60, 54, 68, 72)
ARROW_HEAD = [(52, 69), (76, 69), (64, 85)]


def in_rounded(x, y, x0, y0, x1, y1, r):
    if x0 + r <= x <= x1 - r or y0 + r <= y <= y1 - r:
        if x0 <= x <= x1 and y0 <= y <= y1:
            return True
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return math.hypot(x - cx, y - cy) <= r


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_poly(x, y, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            if x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside


def sample(x, y):
    """返回 (r, g, b, a)，坐标基于 128 设计稿。"""
    if not in_rounded(x, y, *BG_BOX):
        return (0, 0, 0, 0)

    color = BG
    if in_rounded(x, y, *TICKET_BOX) and not (
        in_circle(x, y, *NOTCH_L) or in_circle(x, y, *NOTCH_R)
    ):
        color = TICKET
        shaft = ARROW_SHAFT
        if (shaft[0] <= x <= shaft[2] and shaft[1] <= y <= shaft[3]) or in_poly(
            x, y, ARROW_HEAD
        ):
            color = ARROW

    return (color[0], color[1], color[2], 255)


def render(size):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * 128.0 / size
                    y = (py + (sy + 0.5) / SS) * 128.0 / size
                    r, g, b, a = sample(x, y)
                    acc_r += r * a
                    acc_g += g * a
                    acc_b += b * a
                    acc_a += a
            if acc_a == 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes(
                    (
                        int(acc_r / acc_a + 0.5),
                        int(acc_g / acc_a + 0.5),
                        int(acc_b / acc_a + 0.5),
                        int(acc_a / (SS * SS) + 0.5),
                    )
                )
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(typ, data):
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(
            ">I", zlib.crc32(body) & 0xFFFFFFFF
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "extension", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (48, 96, 128):
        rows = render(size)
        path = os.path.join(out_dir, "icon-%d.png" % size)
        n = write_png(path, size, rows)
        print("wrote %s (%d bytes)" % (path, n))


if __name__ == "__main__":
    main()
