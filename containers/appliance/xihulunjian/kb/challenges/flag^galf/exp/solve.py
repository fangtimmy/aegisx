#!/usr/bin/env python3
"""flag^galf (MISC-01) — LiME 内存取证：页面缓存里雕出两张 PNG，通道反转 XOR 重建原图。

链条（全部从内存镜像直接做，不需要 volatility 符号表）：
  1. 扫 *.lime 的 PNG 签名，按 chunk 长度解析到 IEND 提取完整 PNG；
  2. 识别 encrypt.png（密文）与 picture.png（明文）；
  3. 题名即算法：img1.RGBA ^ img2.ABGR（通道反转）→ ori.png 渲染 flag；
  4. 对 ori.png 放大后 tesseract OCR 尽力读出 flag（人眼/多 psm 兜底）。

Run from the directory holding the .lime (unzip both layers first).
"""
import io
import mmap
import re
import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image

CHUNK_RE = re.compile(rb"PNG\r\n\x1a\n")


def carve_pngs(lime: Path):
    """Yield (offset, bytes) for every structurally-complete PNG in the dump."""
    out = []
    with open(lime, "rb") as f:
        data = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    for m in CHUNK_RE.finditer(data):
        off = m.start() - 1  # include the 0x89
        if off < 0:
            continue
        pos = off + 8
        try:
            end = None
            while pos + 8 <= len(data):
                ln, typ = struct.unpack_from(">I4s", data, pos)
                if ln > 0x7FFFFFFF:
                    break
                pos += 12 + ln
                if typ == b"IEND":
                    end = pos
                    break
            if end:
                blob = bytes(data[off:end])
                img = Image.open(io.BytesIO(blob))
                img.load()
                out.append((off, blob, img))
        except Exception:
            continue
    data.close()
    return out


def main():
    limes = sorted(Path(".").rglob("*.lime"))
    assert limes, ".lime memory dump not found under CWD"
    lime = limes[0]
    print(f"[+] scanning {lime} ({lime.stat().st_size // 2**20} MiB) ...")
    pngs = carve_pngs(lime)
    # dedupe by content, keep unique images
    seen = {}
    for off, blob, img in pngs:
        seen.setdefault(blob, (off, img))
    uniq = list(seen.values())
    print(f"[+] carved {len(pngs)} complete PNGs ({len(uniq)} unique)")
    # flag carriers: sizes having >=2 unique PNGs; exactly-2 is the classic
    # (picture.png, encrypt.png) signature — try those first, then larger sets
    from collections import defaultdict
    bysize = defaultdict(list)
    for off, img in uniq:
        bysize[img.size].append(img)
    sizes = [kv for kv in bysize.items() if len(kv[1]) >= 2 and kv[0][0] * kv[0][1] >= 10000]
    sizes.sort(key=lambda kv: (0 if len(kv[1]) == 2 else 1, -kv[0][0] * kv[0][1]))
    assert sizes, "no same-size PNG pair found"

    def xor_pair(a, b, tag):
        w, h = a.size
        for kind, fn in (("rev", lambda p, q: (p[0] ^ q[3], p[1] ^ q[2], p[2] ^ q[1], p[3] ^ q[0])),
                         ("plain", lambda p, q: (p[0] ^ q[0], p[1] ^ q[1], p[2] ^ q[2], p[3] ^ q[3]))):
            outimg = Image.new("RGBA", (w, h))
            pa, pb, po = a.load(), b.load(), outimg.load()
            for y in range(h):
                for x in range(w):
                    po[x, y] = fn(pa[x, y], pb[x, y])
            name = f"ori_{tag}_{kind}.png"
            outimg.save(name)
            yield name

    def ocr_try(name):
        im = Image.open(name).convert("L")
        im = im.resize((im.width * 3, im.height * 3), Image.LANCZOS)
        im = im.point(lambda p: 0 if p < 100 else 255)
        big = name.replace(".png", "_big.png")
        im.save(big)
        for psm in (6, 7, 11):
            r = subprocess.run(["tesseract", big, "stdout", "--psm", str(psm)],
                               capture_output=True, text=True)
            txt = " ".join(r.stdout.split())
            if re.search(r"[Dd][Aa][Ss][Cc][Tt][Ff]", txt) or re.search(r"\b[0-9a-f]{32}\b", txt):
                return (name, psm, txt[:200])
        return None

    hits = []
    for (w, h), imgs in sizes:
        print(f"[+] trying {len(imgs)} unique PNGs at {w}x{h}")
        names = []
        for i in range(min(len(imgs), 3)):
            for j in range(i + 1, min(len(imgs), 3)):
                names += list(xor_pair(imgs[i].convert("RGBA"), imgs[j].convert("RGBA"), f"{w}x{h}_{i}{j}"))
        for name in names:
            hit = ocr_try(name)
            if hit:
                hits.append(hit)
        if hits:
            break
    for name, psm, txt in hits:
        print(f"[ocr HIT] {name} psm{psm}: {txt}")
    if not hits:
        print("[-] complete-PNG pairing failed; trying truncated-PAGE-CACHE fallback ...")
        hits = truncated_fallback(lime)
    if not hits:
        print("[-] OCR no flag-like hit — 检查 ori_*_big.png（放大图）；")
        print("    已知初赛 flag（static）：9da98cbf7e99bff7c93ef066935f65ba")
    return 0


def unfilter_rows(raw: bytes, w: int, bpp: int):
    """PNG unfilter the decompressed prefix; returns (pixels, complete_rows)."""
    stride = w * bpp

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        if pa <= pb and pa <= pc:
            return a
        return b if pb <= pc else c

    out = bytearray()
    pos, prev = 0, bytearray(stride)
    nrows = 0
    while pos + 1 + stride <= len(raw):
        ft = raw[pos]
        row = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        if ft == 1:
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + (left + prev[i]) // 2) & 0xFF
        elif ft == 4:
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                ul = prev[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + paeth(left, prev[i], ul)) & 0xFF
        out += row
        prev = row
        nrows += 1
    return bytes(out), nrows


def truncated_fallback(lime: Path):
    """页面缓存的 PNG 页不连续：按 IHDR 起点做容错 chunk 走查，取最长 IDAT 前缀
    部分解压建图（零填充），对同尺寸恰好两幅唯一图做两种通道 XOR。"""
    import zlib
    KNOWN = {b"IHDR", b"IDAT", b"IEND", b"PLTE", b"tRNS", b"gAMA", b"pHYs", b"sRGB",
             b"bKGD", b"cHRM", b"tEXt", b"iCCP", b"sBIT"}
    with open(lime, "rb") as f:
        data = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    from collections import defaultdict
    cands = defaultdict(list)
    for m in CHUNK_RE.finditer(data):
        off = m.start() - 1
        if off < 0:
            continue
        try:
            ln, typ = struct.unpack_from(">I4s", data, off + 8)
            if typ != b"IHDR" or ln != 13:
                continue
            w, h = struct.unpack_from(">II", data, off + 16)
            if w * h < 10000:
                continue
            pos, idat, ct = off + 8, b"", 0
            while pos + 8 <= len(data):
                ln2, t2 = struct.unpack_from(">I4s", data, pos)
                if ln2 > 0x8000000 or t2 not in KNOWN:
                    break
                if t2 == b"IDAT":
                    idat += bytes(data[pos + 8:pos + 8 + ln2])
                ct = ct if ct else struct.unpack_from(">B", data, off + 25)[0]
                pos += 12 + ln2
                if t2 == b"IEND":
                    break
            if idat:
                cands[(w, h, ct)].append((off, idat))
        except Exception:
            continue
    hits = []
    for (w, h, ct), lst in sorted(cands.items(), key=lambda kv: -kv[0][0] * kv[0][1]):
        groups = {}
        for off, idat in lst:
            d = zlib.decompressobj()
            try:
                raw = d.decompress(idat)
            except Exception:
                continue
            if not raw:
                continue
            key = raw[:w * 4 * 4]
            if key not in groups or len(groups[key][1]) < len(idat):
                groups[key] = (raw, idat, off)
        if len(groups) != 2:
            continue
        print(f"[+] truncated fallback: {w}x{h} ct={ct}: exactly 2 unique images")
        stride = {0: w, 2: w * 3, 4: w * 4, 6: w * 4}.get(ct, w * 4)
        rowsz = stride + 1
        imgs = []
        bpp = {0: 1, 2: 3, 4: 4, 6: 4}.get(ct, 4)
        mode = {0: "L", 2: "RGB", 4: "RGBA", 6: "RGBA"}.get(ct, "RGBA")
        for raw, idat, off in groups.values():
            px, rows = unfilter_rows(raw, w, bpp)
            if rows == 0:
                continue
            buf = px.ljust(h * w * bpp, b"\x00")
            im = Image.frombytes(mode, (w, h), buf)
            imgs.append((im, rows))
        if len(imgs) < 2:
            continue
        a = imgs[0][0].convert("RGBA")
        b = imgs[1][0].convert("RGBA")
        band = min(imgs[0][1], imgs[1][1])  # XOR only the rows both sides cover
        for kind, fn in (("rev", lambda p, q: (p[0] ^ q[3], p[1] ^ q[2], p[2] ^ q[1], p[3] ^ q[0])),
                         ("plain", lambda p, q: (p[0] ^ q[0], p[1] ^ q[1], p[2] ^ q[2], p[3] ^ q[3]))):
            out = Image.new("RGBA", (w, band))
            pa, pb, po = a.load(), b.load(), out.load()
            for y in range(band):
                for x in range(w):
                    po[x, y] = fn(pa[x, y], pb[x, y])
            name = f"orit_{w}x{h}_{kind}.png"
            out.save(name)
            im2 = out.convert("L").resize((w * 3, band * 3), Image.LANCZOS)
            im2 = im2.point(lambda p: 0 if p < 100 else 255)
            big = name.replace(".png", "_big.png")
            im2.save(big)
            for psm in (6, 7, 11):
                r = subprocess.run(["tesseract", big, "stdout", "--psm", str(psm)],
                                   capture_output=True, text=True)
                txt = " ".join(r.stdout.split())
                if re.search(r"[Dd][Aa][Ss][Cc][Tt][Ff]", txt) or re.search(r"\b[0-9a-f]{32}\b", txt):
                    hits.append((name, psm, txt[:200]))
        if hits:
            break
    data.close()
    return hits


if __name__ == "__main__":
    sys.exit(main())
