#!/usr/bin/env python3
"""给当前隧道地址生成手机扫码图（不依赖 PIL，自写 PNG）。"""
import pathlib
import struct
import zlib

import qrcode

ROOT = pathlib.Path(__file__).resolve().parent.parent
url = (ROOT / '.tunnel-url').read_text(encoding='utf-8-sig').strip()  # utf-8-sig 自动吃掉 BOM

qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=1, border=0)
qr.add_data(url)
qr.make(fit=True)
m = qr.get_matrix()
n = len(m)
SCALE, QUIET = 10, 4
size = (n + QUIET * 2) * SCALE

raw = bytearray()
for y in range(size):
    raw.append(0)
    my = y // SCALE - QUIET
    for x in range(size):
        mx = x // SCALE - QUIET
        black = (0 <= my < n and 0 <= mx < n and m[my][mx])
        raw.extend(b'\x00\x00\x00' if black else b'\xff\xff\xff')


def chunk(tag, data):
    crc = zlib.crc32(tag + data)
    crc = crc % (1 << 32)          # 取低 32 位（不用按位与，避免被当成后台符）
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)


png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
       + chunk(b'IEND', b''))

out = ROOT / 'dist' / 'qr' / 'nebula-tunnel.png'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(png)
print(f'✓ {out}')
print(f'  尺寸 {size}x{size}, {len(png)} 字节')
print(f'  内容 {url}')
