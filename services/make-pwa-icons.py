#!/usr/bin/env python3
"""生成 PWA 图标（192 / 512，另有 180 给 iOS）。
沿用桌面版图标的同一套视觉（黑底、克制辉光、有层次、不用纯白），
纯标准库写 PNG（zlib + struct），不依赖 Pillow。
用法：python services/make-pwa-icons.py
"""
import math
import random
import struct
import zlib
import pathlib
import sys

OUT = pathlib.Path(__file__).resolve().parent.parent / 'web' / 'icons'


def render(S):
    random.seed(20261004 + S)
    px = bytearray(S * S * 4)

    def put(x, y, r, g, b, a):
        if not (0 <= x < S and 0 <= y < S):
            return
        i = (y * S + x) * 4
        sa = a / 255.0
        px[i] = int(px[i] * (1 - sa) + r * sa)
        px[i + 1] = int(px[i + 1] * (1 - sa) + g * sa)
        px[i + 2] = int(px[i + 2] * (1 - sa) + b * sa)
        px[i + 3] = min(255, int(px[i + 3] + a * (1 - px[i + 3] / 255.0)))

    def disk(cx, cy, radius, color, alpha):
        r, g, b = color
        for y in range(max(0, int(cy - radius)), min(S, int(cy + radius) + 1)):
            for x in range(max(0, int(cx - radius)), min(S, int(cx + radius) + 1)):
                if math.hypot(x - cx, y - cy) <= radius:
                    put(x, y, r, g, b, int(alpha))

    C = S / 2
    # 中心柔和核心（峰值亮度压住，不用纯白）
    for rad, col, al in ((S * .102, (255, 246, 226), 26), (S * .070, (255, 248, 232), 40),
                         (S * .043, (255, 250, 240), 62), (S * .020, (255, 252, 246), 96)):
        disk(C, C, rad, col, al)

    # 星场：中心密、外圈疏
    for _ in range(int(S * S * 0.079)):
        th = random.random() * math.tau
        rr = (random.random() ** 1.7) * (S * 0.5)
        t = 1.0 - rr / (S * 0.5)
        a = int(12 + 150 * (t ** 2.4) * (0.35 + 0.65 * random.random()))
        put(int(C + math.cos(th) * rr), int(C + math.sin(th) * rr * 0.98),
            int(210 + 45 * random.random()), int(224 + 31 * random.random()),
            int(232 + 23 * random.random()), a)

    # 极淡的环，做出空间感
    for _ in range(int(S * S * 0.040)):
        th = random.random() * math.tau
        rr = S * (0.34 + 0.03 * random.random())
        put(int(C + math.cos(th) * rr), int(C + math.sin(th) * rr), 150, 178, 196,
            int(6 + 14 * random.random()))

    # 暗角：小尺寸下边界更清晰
    for y in range(S):
        for x in range(S):
            d = math.hypot(x - C, y - C) / (S * 0.5)
            if d > 0.82:
                f = max(0.0, 1.0 - ((d - 0.82) / 0.18) * 1.15)
                i = (y * S + x) * 4
                for k in range(4):
                    px[i + k] = int(px[i + k] * f)

    raw = b''.join(b'\x00' + bytes(px[y * S * 4:(y + 1) * S * 4]) for y in range(S))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


OUT.mkdir(parents=True, exist_ok=True)
for size, name in ((192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')):
    data = render(size)
    (OUT / name).write_bytes(data)
    print(f'✓ {OUT / name}  ({size}x{size}, {len(data)} 字节)')
