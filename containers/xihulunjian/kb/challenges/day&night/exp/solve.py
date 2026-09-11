#!/usr/bin/env python3
"""day&night (MISC-05) — night.jpg steghide → punched QR v4-H → ROT47.

1. night.jpg 的 XMP 里藏着伪装成 Lens Manufacturer 的密码（S1cre4_777）。
2. steghide 解出 400x400 PNG：被圆形遮罩裁掉三个定位角的 QR。
   手动按 v4-H（4 blocks of (25,9)，format info 实证 mask 0）解码。
3. payload 是 ROT47 过的 flag。

Needs: Pillow, steghide（镜像内置）。Run from the directory holding
day&night的附件.zip（或其解压后的 day.png / night.jpg）。
"""
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np

work = Path(tempfile.mkdtemp(prefix="daynight-"))

# ---------- locate attachment / images ----------
night = None
zip_candidates = sorted(Path(".").rglob("*附件.zip")) or sorted(Path(".").rglob("*.zip"))
for z in zip_candidates:
    d = work / z.stem
    subprocess.run(["unzip", "-o", "-q", str(z), "-d", str(d)], check=False)
    for p in d.rglob("*.zip"):
        subprocess.run(["unzip", "-o", "-q", str(p), "-d", str(d / "inner")], check=False)
    for p in d.rglob("night.jpg"):
        night = p
if night is None:
    night = next(iter(sorted(Path(".").rglob("night.jpg"))), None)
assert night, "night.jpg not found under CWD"
print(f"[+] night.jpg: {night}")

# ---------- steghide password hidden in XMP ----------
raw = night.read_bytes()
m = re.search(rb'Lens Manufacturer="([^"]+)"', raw) or re.search(rb"Lens Manufacturer=([^/\s<]+)", raw)
pw = m.group(1).decode() if m else "S1cre4_777"
print(f"[+] XMP password: {pw}")
steg_png = work / "steg_out.png"
r = subprocess.run(["steghide", "extract", "-sf", str(night), "-p", pw, "-xf", str(steg_png)],
                   capture_output=True)
assert r.returncode == 0 and steg_png.exists(), "steghide extraction failed (password changed?)"
print(f"[+] steghide → {steg_png.name} ({steg_png.stat().st_size} bytes)")

# ---------- read the punched QR (v4, 33x33 modules in a 357px box at (21,21)) ----------
disc = Image_open = None
from PIL import Image
disc = Image.open(steg_png).convert("L")
A = np.array(disc)
black = A < 128

N, x0, span = 33, 21, 357
step = span / N
grid = np.zeros((N, N), dtype=int)
for i in range(N):
    for j in range(N):
        ya, yb = int(round(x0 + i * step)), int(round(x0 + (i + 1) * step))
        xa, xb = int(round(x0 + j * step)), int(round(x0 + (j + 1) * step))
        cell = black[ya:yb, xa:xb]
        if cell.size:
            grid[i, j] = cell.mean() > 0.5

func = np.zeros((N, N), dtype=bool)
for (r0, c0) in [(0, 0), (0, 25), (25, 0)]:
    func[r0:r0 + 8, c0:c0 + 8] = True          # finders + separators
func[6, :] = True
func[:, 6] = True                               # timing
func[24:29, 24:29] = True                       # alignment (26,26)
fmt1 = [(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8), (7, 8),
        (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)]
fmt2 = [(8, 32), (8, 31), (8, 30), (8, 29), (8, 28), (8, 27), (8, 26), (8, 25),
        (32, 8), (31, 8), (30, 8), (29, 8), (28, 8), (27, 8), (26, 8)]
for rr, cc in fmt1 + fmt2:
    func[rr, cc] = True
func[25, 8] = True                              # dark module

fv = 0
for rr, cc in fmt1:
    fv = (fv << 1) | int(grid[rr, cc])
FMT = {0b001011010001001: 0, 0b001001110111110: 1, 0b001110011100111: 2, 0b001100111010000: 3,
       0b000011101100110: 4, 0b000001001010101: 5, 0b000110100001100: 6, 0b000100000111011: 7}
assert fv in FMT, f"unexpected format info {fv:015b} (level H expected)"
mask_id = FMT[fv]
print(f"[+] format info: EC level H, mask {mask_id}")

MASKS = [
    lambda i, j: (i + j) % 2 == 0,
    lambda i, j: i % 2 == 0,
    lambda i, j: j % 3 == 0,
    lambda i, j: (i + j) % 3 == 0,
    lambda i, j: (i // 2 + j // 3) % 2 == 0,
    lambda i, j: (i * j) % 2 + (i * j) % 3 == 0,
    lambda i, j: ((i * j) % 2 + (i * j) % 3) % 2 == 0,
    lambda i, j: ((i + j) % 2 + (i * j) % 3) % 2 == 0,
]
um = grid.copy()
for i in range(N):
    for j in range(N):
        if not func[i, j] and MASKS[mask_id](i, j):
            um[i, j] ^= 1

bp = []
col = 32
upward = True
while col > 0:
    if col == 6:
        col -= 1
    rows = range(32, -1, -1) if upward else range(33)
    for r in rows:
        for c in (col, col - 1):
            if not func[r, c]:
                bp.append((r, c))
    upward = not upward
    col -= 2
bits = [int(um[r, c]) for (r, c) in bp]
cw = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits) - 7, 8)]
assert len(cw) == 100, f"codeword count {len(cw)} != 100"

# ---------- inline Reed–Solomon over GF(256) (QR: fcr=0, generator=2) ----------
EXP = [0] * 512
LOG = [0] * 256
_v = 1
for _i in range(255):
    EXP[_i] = _v
    LOG[_v] = _i
    _v <<= 1
    if _v & 0x100:
        _v ^= 0x11D
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]


def gmul(a, b):
    return 0 if a == 0 or b == 0 else EXP[LOG[a] + LOG[b]]


def gdiv(a, b):
    assert b != 0
    return EXP[(LOG[a] + 255 - LOG[b]) % 255] if a else 0


def gpow(g, p):
    return EXP[(LOG[g] * p) % 255]


def ginv(a):
    return EXP[255 - LOG[a]]


def poly_add(p, q):
    r = [0] * max(len(p), len(q))
    for i, c in enumerate(p):
        r[i + len(r) - len(p)] ^= c
    for i, c in enumerate(q):
        r[i + len(r) - len(q)] ^= c
    return r


def poly_scale(p, s):
    return [gmul(c, s) for c in p]


def poly_mul(p, q):
    r = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        if a:
            for j, b in enumerate(q):
                if b:
                    r[i + j] ^= gmul(a, b)
    return r


def poly_eval(p, x):
    y = p[0]
    for c in p[1:]:
        y = gmul(y, x) ^ c
    return y


def syndromes(msg, nsym):
    return [poly_eval(msg, gpow(2, i)) for i in range(nsym)]


def rs_correct(msg_in, nsym):
    msg = list(msg_in)
    synd = syndromes(msg, nsym)
    if max(synd) == 0:
        return msg
    err_loc = [1]
    old_loc = [1]
    for i in range(nsym):
        delta = synd[i]
        for j in range(1, len(err_loc)):
            delta ^= gmul(err_loc[-(j + 1)], synd[i - j])
        old_loc = old_loc + [0]
        if delta != 0:
            if len(old_loc) > len(err_loc):
                new_loc = poly_scale(old_loc, delta)
                old_loc = poly_scale(err_loc, ginv(delta))
                err_loc = new_loc
            err_loc = poly_add(err_loc, poly_scale(old_loc, delta))
    while len(err_loc) and err_loc[0] == 0:
        err_loc.pop(0)
    errs = len(err_loc) - 1
    assert 0 <= errs * 2 <= nsym, "too many errors to correct"
    pos = []
    for i in range(len(msg)):
        if poly_eval(err_loc[::-1], gpow(2, i)) == 0:
            pos.append(len(msg) - 1 - i)
    assert len(pos) == errs, "chien search mismatch"
    coef_pos = [len(msg) - 1 - p for p in pos]
    # errata locator
    e_loc = [1]
    for cp in coef_pos:
        e_loc = poly_mul(e_loc, poly_add([1], [gpow(2, cp), 0]))
    # error evaluator
    remainder = poly_mul(synd[::-1], e_loc)
    err_eval = remainder[len(remainder) - (len(e_loc) - 1):][::-1]
    X = [gpow(2, -(255 - cp) % 255) for cp in coef_pos]
    E = [0] * len(msg)
    for i, Xi in enumerate(X):
        Xi_inv = ginv(Xi)
        prime = 1
        for j in range(len(X)):
            if j != i:
                prime = gmul(prime, 1 ^ gmul(Xi_inv, X[j]))
        y = poly_eval(err_eval[::-1], Xi_inv)
        E[pos[i]] = gdiv(y, prime)
    msg = poly_add(msg, E)
    assert max(syndromes(msg, nsym)) == 0, "RS correction failed"
    return msg


# ---------- de-interleave v4-H: 4 blocks of (total 25, data 9) ----------
data_cw, ec_cw = cw[0:36], cw[36:100]
out = []
for b in range(4):
    blk = data_cw[b::4] + ec_cw[b::4]
    dec = rs_correct(blk, 16)
    out += dec[:9]

stream = "".join(f"{v:08b}" for v in out)
mode = int(stream[:4], 2)
ln = int(stream[4:12], 2)
assert mode == 4, f"unexpected mode {mode}"
payload = bytes(int(stream[12 + 8 * i:20 + 8 * i], 2) for i in range(ln))
print(f"[+] payload ({ln} bytes): {payload!r}")

rot47 = lambda s: "".join(chr(33 + (ord(c) - 33 + 47) % 94) for c in s)
flag = rot47(payload.decode())
print("[+] FLAG :", flag)
