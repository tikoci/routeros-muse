#!/usr/bin/env python3
"""check-png.py — stdlib-only PNG assertions: exact dimensions + non-blank.

Vendored copy of the map-reports pattern: parses IHDR, requires 8-bit
RGB/RGBA non-interlaced, un-filters IDAT scanlines (all five PNG filter
types) and counts unique pixels with an early exit once the threshold is
comfortably exceeded.

Usage: check-png.py <path> <width> <height> <min-unique-colors>
"""
import struct
import sys
import zlib


def unfILTER(raw: bytes, w: int, h: int, bpp: int) -> bytes:
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ftype != 0:
            raise ValueError(f"unknown filter {ftype} on row {y}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return bytes(out)


def main() -> int:
    path, want_w, want_h, want_colors = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, w = 8, None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            w, h, depth, color, comp, filt, inter = struct.unpack(">IIBBBBB", chunk)
            assert depth == 8, f"want 8-bit, got {depth}"
            assert color in (2, 6), f"want RGB(A), got color type {color}"
            assert inter == 0, "interlaced PNG not supported"
            bpp = 3 if color == 2 else 4
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length
    assert w == want_w and h == want_h, f"want {want_w}x{want_h}, got {w}x{h}"
    px = unfILTER(zlib.decompress(bytes(idat)), w, h, bpp)
    seen = set()
    for i in range(0, len(px), bpp):
        seen.add(px[i:i + bpp])
        if len(seen) >= want_colors + 500:
            break
    print(f"ok: {path} is {w}x{h}, unique sampled colors: {len(seen)} (min {want_colors})")
    if len(seen) < want_colors:
        print(f"FAIL: only {len(seen)} unique colors, page looks blank")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
