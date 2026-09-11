#!/usr/bin/env python3
"""GCD，杠上了 (CRYPTO-09) — ACD via SDA lattice (needs fpylll).

tasks.py leaks k=4 samples x_i = p*q_i + e_i (p 768-bit, q_i 1000-bit,
|e_i| < 2^255). The (t+1)x(t+1) Simultaneous Diophantine Approximation lattice
contains (q_0..q_t) as a short vector; LLL recovers it, then
p = (x_0 - centered(x_0 mod q_0)) / q_0.
flag = DASCTF{sha256(hex(p))[:32]}. Finds tasks.py recursively from CWD.
"""
import hashlib
import re
from pathlib import Path

from fpylll import IntegerMatrix, LLL

RHO = 255

cands = sorted(Path(".").rglob("tasks.py"))
assert cands, "tasks.py not found under CWD (unzip attachment first)"
xs = [int(n) for n in re.findall(r"\b\d{20,}\b", cands[0].read_text())]
print("[+] samples:", len(xs), [x.bit_length() for x in xs])


def sda_attack(xsr):
    t = len(xsr) - 1
    x0 = xsr[0]
    m = IntegerMatrix(t + 1, t + 1)
    m[0, 0] = 2 ** (RHO + 1)
    for j in range(1, t + 1):
        m[0, j] = xsr[j]
    for i in range(1, t + 1):
        m[i, i] = -x0
    LLL.reduction(m, delta=0.99)
    for row in range(t + 1):
        w = [m[row, j] for j in range(t + 1)]
        if w[0] == 0 or w[0] % (2 ** (RHO + 1)) != 0:
            continue
        q0 = abs(w[0]) // (2 ** (RHO + 1))
        if q0.bit_length() >= 2000:
            continue
        r0 = x0 % q0
        e0 = r0 if r0 <= q0 // 2 else r0 - q0  # centered residue (neg noise!)
        if (x0 - e0) % q0:
            continue
        p = (x0 - e0) // q0
        if p > 1 and all(min(xi % p, p - xi % p) < 2 ** 256 for xi in xsr):
            return p
    return None


for shift in range(len(xs)):
    p = sda_attack(xs[shift:] + xs[:shift])
    if p:
        h = hashlib.sha256(hex(p).encode()).hexdigest()[:32]
        print(f"[+] p recovered ({p.bit_length()} bits) with base sample {shift}")
        print("[+] FLAG : DASCTF{" + h + "}")
        break
else:
    raise SystemExit("[-] SDA failed on all rotations")
