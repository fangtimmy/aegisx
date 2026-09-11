#!/usr/bin/env python3
"""QRCodeWorld (REVERSE-07, Unity IL2CPP) — deterministic flag recovery.

The QR payload is baked into global-metadata.dat (field default-value blob),
NOT generated at runtime: find the 29x29 0/1 int32 window in the
fieldAndParameterDefaultValueData section, render it, decode with pyzbar.
No need to unpack GameAssembly.dll (that path is only for re-analysis).
"""
import struct
from pathlib import Path

import numpy as np
from PIL import Image
from pyzbar.pyzbar import decode as qr_decode

SIZE = 29


def find_metadata() -> Path:
    cands = [p for p in Path(".").rglob("global-metadata.dat")]
    assert cands, "global-metadata.dat not found under CWD (unzip the attachment first)"
    return cands[0]


def section(meta: bytes, off: int) -> tuple[int, int]:
    return struct.unpack_from("<II", meta, off)


def find_qr_blob(meta: bytes) -> np.ndarray:
    # fieldAndParameterDefaultValueData is the 9th header section -> offset 8+8*8
    fapd_off, fapd_size = section(meta, 72)
    data = meta[fapd_off:fapd_off + fapd_size]
    a = np.frombuffer(data, dtype="<u4")
    n = SIZE * SIZE
    for i in range(len(a) - n + 1):
        w = a[i:i + n]
        if np.all((w == 0) | (w == 1)):
            ones = int(w.sum())
            if 200 < ones < 650:
                return w.reshape(SIZE, SIZE)
    raise RuntimeError("QR blob not found")


def render(grid: np.ndarray, quiet: int = 4, scale: int = 10) -> Image.Image:
    h, w = grid.shape
    img = np.ones((h + 2 * quiet, w + 2 * quiet), dtype=np.uint8) * 255
    img[quiet:quiet + h, quiet:quiet + w] = np.where(grid == 1, 0, 255)
    return Image.fromarray(img).resize(((w + 2 * quiet) * scale, (h + 2 * quiet) * scale), Image.NEAREST)


def main() -> None:
    meta = find_metadata().read_bytes()
    assert struct.unpack_from("<I", meta, 0)[0] == 0xFAB11BAF, "bad metadata magic"
    im = render(find_qr_blob(meta))
    im.save("qr_flag.png")
    res = qr_decode(im)
    assert res, "pyzbar decode failed"
    print("[+] FLAG :", res[0].data.decode())


if __name__ == "__main__":
    main()
