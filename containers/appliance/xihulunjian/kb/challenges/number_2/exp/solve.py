#!/usr/bin/env python3
"""number_2 (CRYPTO-05) — deterministic flag recovery (needs fpylll).

Part 1: Coppersmith small root of (T-x)(T-y) mod n recovers m (<2^160), then
p = gcd(x-m, n). Part 2: kernel lattice over 18 congruences recovers
(k_i, b_i), then AES-CBC decrypt. Finds output.txt recursively from CWD.
"""
import ast
import hashlib
import math
from pathlib import Path

from Crypto.Cipher import AES
from fpylll import BKZ, LLL, IntegerMatrix

cands = sorted(Path(".").rglob("output.txt"))
assert cands, "output.txt not found under CWD (unzip number_2的附件.zip first)"
src = cands[0].read_text()

env = {}
for ln in src.split("\n"):
    ln = ln.strip()
    if ln.startswith("n = "):
        env["n1"] = int(ln[4:])
    elif ln.startswith("x = "):
        env["x1"] = int(ln[4:])
    elif ln.startswith("y = "):
        env["y1"] = int(ln[4:])
    elif ln.startswith("s = "):
        env["s"] = ast.literal_eval(ln[4:])
    elif ln.startswith("t = "):
        env["t"] = ast.literal_eval(ln[4:])
    elif ln.startswith("r = "):
        env["r"] = ast.literal_eval(ln[4:])
    elif ln.startswith("q = "):
        env["q"] = int(ln[4:])
    elif ln.startswith("cipher = "):
        env["cipher"] = ast.literal_eval(ln[9:])

n1, x1, y1, qq = env["n1"], env["x1"], env["y1"], env["q"]
s, t, r = env["s"], env["t"], env["r"]

# ---- Part 1: Coppersmith small root ----
N = n1
X = 1 << 160
a1 = -(x1 + y1) % N
a0 = (x1 * y1) % N
B = IntegerMatrix(3, 3)
B[0, 0] = N
B[1, 1] = N * X
B[2, 0] = a0
B[2, 1] = a1 * X
B[2, 2] = X * X
LLL.reduction(B)
roots = set()
for i in range(3):
    c0, c1, c2 = B[i][0], B[i][1] // X, B[i][2] // (X * X)
    if c2 == 0 and c1 == 0:
        continue
    if c2 != 0:
        disc = c1 * c1 - 4 * c2 * c0
        if disc < 0:
            continue
        sq = math.isqrt(disc)
        if sq * sq != disc:
            continue
        for num in (-c1 + sq, -c1 - sq):
            if num % (2 * c2) == 0:
                roots.add(num // (2 * c2))
    elif c1 != 0 and c0 % c1 == 0:
        roots.add(-c0 // c1)
m = p = None
from math import gcd
for cand in roots:
    if 0 < cand < X:
        g = gcd(x1 - cand, N)
        if 1 < g < N:
            m, p = cand, g
            break
assert m, "part1 failed"
p2 = N // p
print("[+] part1: m, p recovered")

# ---- Part 2: kernel lattice ----
nn, cols = 18, 36
A = [[0] * cols for _ in range(nn - 1)]
for i in range(1, nn):
    row = A[i - 1]
    row[0] = (-r[i] * s[0]) % qq
    row[1] = (r[i] * t[0]) % qq
    row[2 * i] = (s[i] * r[0]) % qq
    row[2 * i + 1] = (-t[i] * r[0]) % qq


def rref(A, q):
    m_, n_ = len(A), len(A[0])
    A = [row[:] for row in A]
    pivots = []
    pr = 0
    for pc in range(n_):
        piv = next((rr for rr in range(pr, m_) if A[rr][pc] % q != 0), None)
        if piv is None:
            continue
        A[pr], A[piv] = A[piv], A[pr]
        inv = pow(A[pr][pc], -1, q)
        A[pr] = [(v * inv) % q for v in A[pr]]
        for rr in range(m_):
            if rr != pr and A[rr][pc] % q != 0:
                f = A[rr][pc]
                A[rr] = [(A[rr][j] - f * A[pr][j]) % q for j in range(n_)]
        pivots.append((pr, pc))
        pr += 1
        if pr == m_:
            break
    return A, pivots


R, piv = rref(A, qq)
pivcols = {c for _, c in piv}
K = []
for f in [c for c in range(cols) if c not in pivcols]:
    v = [0] * cols
    v[f] = 1
    for pr, pc in piv:
        v[pc] = (-R[pr][f]) % qq
    K.append(v)

L = IntegerMatrix(len(K) + cols, cols)
for i, v in enumerate(K):
    for j in range(cols):
        L[i, j] = v[j]
for i in range(cols):
    L[len(K) + i, i] = qq
LLL.reduction(L)
BKZ.reduction(L, BKZ.Param(block_size=20))

Kbound = 1 << 480
row = None
for i in range(L.nrows):
    rw = [L[i, j] for j in range(cols)]
    if all((Kbound >> 2) < abs(v) < (Kbound << 1) for v in rw):
        row = rw
        break
assert row, "no candidate vector"
s0 = 1 if row[0] > 0 else -1
kv = [v * s0 for v in row]
k = [kv[2 * i] for i in range(nn)]
b = [kv[2 * i + 1] for i in range(nn)]
x2 = (s[0] * k[0] - b[0] * t[0]) * pow(r[0], -1, qq) % qq
ok = all((s[i] * k[i] - b[i] * t[i]) * pow(r[i], -1, qq) % qq == x2 for i in range(nn))
print("[+] part2: all equations check:", ok)

for iv_p in (p, p2):
    iv = hashlib.sha256(str(iv_p).encode()).digest()[:16]
    key = hashlib.sha256(str(2024 * b[0] + 2023 * k[0] + x2).encode()).digest()[:16]
    pt = AES.new(key, AES.MODE_CBC, iv).decrypt(env["cipher"])
    if b"DASCTF" in pt or all(32 <= c < 127 or c == pt[-1] for c in pt[:-1]):
        print("[+] FLAG :", pt.rstrip(bytes([pt[-1]])).decode(errors="replace"))
