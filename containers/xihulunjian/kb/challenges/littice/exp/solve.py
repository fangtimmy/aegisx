#!/usr/bin/env python3
"""littice (CRYPTO-06) — Hidden Number Problem over RSA phi leak (needs fpylll).

challenge.py leaks 110 samples w_i ≈ (phi*X_i) mod n with error < d = n^0.86.
With s = p+q-1 (phi = n - s):  s*X_i + e_i ≡ -w_i (mod n).
Embedding lattice (dim 112) + LLL recovers s; then factor n and decrypt enc.
Finds challenge.py recursively from CWD.
"""
import ast
import math
from pathlib import Path

from Crypto.Util.number import inverse, long_to_bytes
from fpylll import IntegerMatrix, LLL

cands = sorted(Path(".").rglob("challenge.py"))
assert cands, "challenge.py not found under CWD (unzip littice的附件.zip first)"
env = {}
for ln in cands[0].read_text().split("\n"):
    if not ln.startswith("#"):
        continue
    ln = ln.lstrip("# ").strip()
    if ln.startswith("n = "):
        env["n"] = int(ln[4:])
    elif ln.startswith("X = "):
        env["X"] = ast.literal_eval(ln[4:])
    elif ln.startswith("XXX = "):
        env["W"] = ast.literal_eval(ln[6:])
    elif ln.startswith("enc = "):
        env["enc"] = int(ln[6:])

n, X, W, enc = env["n"], env["X"], env["W"], env["enc"]
m = len(X)
d = int(n ** 0.86)
u = [(-w) % n for w in W]
M = 1 << 886
dim = m + 2
B = IntegerMatrix(dim, dim)
for i in range(m):
    B[i, i] = n
for j in range(m):
    B[m, j] = X[j]
B[m, m] = 1
for j in range(m):
    B[m + 1, j] = u[j]
B[m + 1, m + 1] = M
LLL.reduction(B)


def try_s(s):
    phi = n - s
    if phi <= 0:
        return None
    for i in range(3):
        if abs(phi * X[i] % n - W[i]) > d:
            return None
    spq = n - phi + 1
    disc = spq * spq - 4 * n
    if disc < 0:
        return None
    r = math.isqrt(disc)
    if r * r != disc:
        return None
    p, q = (spq + r) // 2, (spq - r) // 2
    return (p, q) if p * q == n else None


for row in range(dim):
    last = B[row, m + 1]
    if last in (M, -M):
        p, q = try_s(abs(B[row, m]))
        if p:
            dd = inverse(65537, n - abs(B[row, m]))
            print("[+] FLAG :", long_to_bytes(pow(enc, dd, n)).decode())
            break
else:
    raise SystemExit("[-] embedding vector not found — rerun or raise BKZ")
