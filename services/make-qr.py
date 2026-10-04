#!/usr/bin/env python3
"""生成手机访问用的二维码（不依赖 PIL：直接取 QR 矩阵，自己写 PNG）。
用法：python services/make-qr.py
"""
import pathlib
import struct
import zlib

import qrcode

OUT = pathlib.Path(__file__).resolve().parent.parent / 'dist' / 'qr'
TARGETS = [
    ('lan',      'http://192.168.11.86:8080/', '家里同一个 Wi-Fi'),
    ('zerotier', 'http://10.122.193.37:8080/', '在外面（ZeroTier）'),
]
SCALE = 10     # 每个模块 10 像素，手机扫得清
QUIET = 4      # 静区（QR 规范要求的留白，少了识别率会掉）


def write_png(path, matrix):
    """matrix: 二维布尔列表（True=黑）。白底黑块，扫码识别最稳。"""
    n = len(matrix)
    size = (n + QUIET * 2) * SCALE
    raw = bytearray()
    for y in range(size):
        raw.append(0)                       # 每行的 filter type
        my = y // SCALE - QUIET
        for x in range(size):
            mx = x // SCALE - QUIET
            black = (0 <= my < n and 0 <= mx < n and matrix[my][mx])
            raw.extend(b'\x00\x00\x00' if black else b'\xff\xff\xff')

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    path.write_bytes(png)
    return size, len(png)


OUT.mkdir(parents=True, exist_ok=True)
for key, url, desc in TARGETS:
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M,
                       box_size=1, border=0)
    qr.add_data(url)
    qr.make(fit=True)
    m = qr.get_matrix()
    f = OUT / f'nebula-{key}.png'
    size, nbytes = write_png(f, m)
    print(f'✓ {f}')
    print(f'   {desc}  {url}')
    print(f'   {size}x{size}px, {nbytes} 字节, {len(m)}x{len(m)} 模块')
