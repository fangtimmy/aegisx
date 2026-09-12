#!/usr/bin/env python3
"""RSA_E (西湖论剑初赛 CRYPTO-07) solver.

Stage 1 (works): Boneh-Durfee on RSA1 (e_n, e_e) with 276-bit private exponent
    -> recover d -> e = pow(e_c, d, e_n), the public exponent of RSA2.
Stage 2 (blocked on the shipped instance): RSA2 encrypts related messages
    c = m^e mod nn, cc = (n-m)^e mod nn.  Franklin-Reiter via polynomial gcd
    gcd(x^e - c, (n-x)^e - cc) mod nn needs degree-e polynomials; the shipped
    e is 255-bit (~3e76), which is computationally infeasible (open problem,
    cf. Boneh's "Twenty Years of Attacks on the RSA").  The FR implementation
    here runs automatically whenever e is small enough (finals instance may
    differ); otherwise it reports the blocker and exits.

Usage:
    python3 solve.py [path-to-RSA_E.py]
Locates the attachment by rglob from CWD when no path is given.
Set BD_SELFTEST=1 to run the pipeline on a self-generated instance instead.
"""
import os
import re
import sys
import json
import math
import time
from pathlib import Path

# ---------------------------------------------------------------- parameters
def parse_params(text):
    out = {}
    for name in ("e_n", "e_e", "e_c", "n", "nn", "c", "cc"):
        m = re.search(rf"^\s*{name}\s*=\s*(\d+)", text, re.M)
        if not m:
            raise ValueError(f"parameter {name} not found")
        out[name] = int(m.group(1))
    return out


def locate_attachment():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    for root in (Path.cwd(), Path("/w"), Path("/tmp"), Path.home()):
        hits = [p for p in root.rglob("RSA_E.py") if p.is_file()]
        if hits:
            return hits[0]
    raise FileNotFoundError("RSA_E.py not found; pass its path as argv[1]")


if os.environ.get("BD_SELFTEST"):
    import random
    from Crypto.Util.number import getPrime
    import sympy
    while True:
        p_ = getPrime(512); q_ = getPrime(512)
        e_n = p_ * q_
        phi = (p_ - 1) * (q_ - 1)
        d_true = random.getrandbits(276) | (1 << 275) | 1
        if math.gcd(d_true, phi) != 1:
            continue
        e_e = int(sympy.invert(d_true, phi))
        if math.gcd(e_e, phi) != 1:
            continue
        break
    k_true = (e_e * d_true - 1) // phi
    e_c = pow(3050184286028759423775106364605014277417639605110942508717751379208991304504327, e_e, e_n)  # arbitrary message
    nn = getPrime(512) * getPrime(512)
    n = getPrime(512) * getPrime(512)
    c = cc = 0
    print(f"[*] selftest: d {d_true.bit_length()} bits, k {k_true.bit_length()} bits")
else:
    attachment = locate_attachment()
    print(f"[*] attachment: {attachment}")
    P = parse_params(attachment.read_text(errors="replace"))
    e_n, e_e, e_c = P["e_n"], P["e_e"], P["e_c"]
    n, nn, c, cc = P["n"], P["nn"], P["c"], P["cc"]

print(f"[*] e_n {e_n.bit_length()} bits, e_e {e_e.bit_length()} bits, nn {nn.bit_length()} bits")

# ---------------------------------------------------------------- stage 1a: Wiener
def wiener():
    cf, a, b = [], e_e, e_n
    while b:
        cf.append(a // b)
        a, b = b, a - b * (a // b)
    p0, p1, q0, q1 = 0, 1, 1, 0
    for q in cf:
        p0, p1 = p1, q * p1 + p0
        q0, q1 = q1, q * q1 + q0
        k, d = p1, q1
        if k and (e_e * d - 1) % k == 0 and pow(2, e_e * d, e_n) == 2:
            return d
    return None

d = wiener()
print("[*] wiener:", "hit" if d else "no")

# ---------------------------------------------------------------- stage 1b: Boneh-Durfee
if not d:
    from fpylll import IntegerMatrix, LLL
    import sympy

    A = (e_n + 1) // 2           # f(x,y) = 1 + x*(A + y), root (2k, -(p+q)/2)
    DELTA = 276 / 1024
    P_BIG = int(sympy.nextprime(1 << 300))
    w_sym, z_sym = sympy.symbols("w z")

    def pmul(p, q):
        r = {}
        for k1, v1 in p.items():
            for k2, v2 in q.items():
                key = (k1[0] + k2[0], k1[1] + k2[1], k1[2] + k2[2])
                r[key] = r.get(key, 0) + v1 * v2
        return {k: v for k, v in r.items() if v}

    def lift(p):
        # enforce u = x*y + 1 (kill monomials containing x*y pairs)
        p = {k: v for k, v in p.items() if v}
        while True:
            bad = next((k for k in p if k[1] > 0 and k[2] > 0), None)
            if bad is None:
                return p
            a, b, c = bad
            v = p.pop(bad)
            for key, sign in (((a + 1, b - 1, c - 1), 1), ((a, b - 1, c - 1), -1)):
                p[key] = p.get(key, 0) + sign * v
                if p[key] == 0:
                    del p[key]

    def boneh_durfee(m, t):
        M = e_e
        f = {(1, 0, 0): 1, (0, 1, 0): A}          # f = u + A*x with u = xy+1
        fp = [{(0, 0, 0): 1}]
        for _ in range(m):
            fp.append(pmul(fp[-1], f))
        X, Y = 1 << 277, 1 << 512                 # x0=2k, y0=-(p+q)/2
        UU = X * Y + 1

        polys = []
        for kk in range(m + 1):
            for ii in range(m - kk + 1):
                g = {(a, b + ii, c): v * pow(M, m - kk) for (a, b, c), v in fp[kk].items()}
                polys.append(lift(g))
        fl = math.floor(m / t)
        for jj in range(1, t + 1):
            for kk in range(fl * jj, m + 1):
                g = {(a, b, c + jj): v * pow(M, m - kk) for (a, b, c), v in fp[kk].items()}
                polys.append(lift(g))

        mono_set = set()
        for g in polys:
            mono_set |= set(g.keys())
        xmonos = sorted([k for k in mono_set if k[2] == 0], key=lambda k: (sum(k), k[0], k[1]))
        ymonos = sorted([k for k in mono_set if k[2] > 0], key=lambda k: (k[2], sum(k), k[0]))
        monomials = xmonos + ymonos
        idx = {mo: i for i, mo in enumerate(monomials)}
        nn_, nc = len(polys), len(monomials)

        def bound(mo):
            a, b, c = mo
            return pow(UU, a) * pow(X, b) * pow(Y, c)

        B = IntegerMatrix(nn_, nc)
        for i, g in enumerate(polys):
            for mo, v in g.items():
                B[i, idx[mo]] = v * bound(mo)
        t0 = time.time()
        LLL.reduction(B)
        print(f"[*] BD m={m} t={t} dim={nn_}x{nc} LLL {time.time()-t0:.1f}s", flush=True)

        def row_to_poly(row_i):
            cs = {}
            for j, mo in enumerate(monomials):
                bj = bound(mo)
                v = B[row_i, j]
                if v % bj:
                    v = round(v / bj)
                else:
                    v //= bj
                if not v:
                    continue
                a, b, c = mo
                for tt in range(a + 1):
                    key = (b + tt, c + tt)
                    cs[key] = cs.get(key, 0) + v * math.comb(a, tt)
            return {k: v for k, v in cs.items() if v}

        return [row_to_poly(i) for i in range(min(4, nn_))]

    def try_k(k):
        k = int(k)
        if k == 0:
            return None
        for ks in (k, -k):
            try:
                phi0 = int((-sympy.invert(ks, e_e)) % e_e)
            except Exception:
                continue
            for tt in range(4):
                phi = phi0 + tt * e_e
                if phi <= 0 or phi >= e_n + 1:
                    continue
                s = e_n + 1 - phi
                if s <= 0 or s.bit_length() > 514:
                    continue
                disc = s * s - 4 * e_n
                if disc < 0:
                    continue
                r = math.isqrt(disc)
                if r * r == disc:
                    dd = (ks * phi + 1) // e_e
                    if dd > 0 and pow(2, e_e * dd, e_n) == 2:
                        return (ks, dd, phi)
        return None

    def find_roots(pair):
        p1 = {k: int(v) for k, v in pair[0].items()}
        p2 = {k: int(v) for k, v in pair[1].items()}
        e1 = sum(sympy.Integer(v) * w_sym ** k[0] * z_sym ** k[1] for k, v in p1.items())
        e2 = sum(sympy.Integer(v) * w_sym ** k[0] * z_sym ** k[1] for k, v in p2.items())
        res = sympy.resultant(sympy.Poly(e1, z_sym, w_sym), sympy.Poly(e2, z_sym, w_sym), z_sym)
        if res == 0:
            return None
        rp = sympy.Poly(res, w_sym)
        rp_mod = sympy.Poly(rp.as_expr(), w_sym, modulus=P_BIG)
        lins = []
        for fac, _ in rp_mod.factor_list()[1]:
            if fac.degree() == 1:
                cc_, b_ = fac.all_coeffs()
                lins.append(int((-b_ * sympy.invert(int(cc_), P_BIG)) % P_BIG))
        print(f"    resultant ok, linear roots mod p: {len(lins)}", flush=True)
        for v in lins:
            for wc in (v, v - P_BIG):
                if wc % 2 == 0:
                    hit = try_k(wc // 2)
                    if hit:
                        return hit
        return None

    for (m_, t_) in [(6, 3), (6, 2), (5, 2), (7, 3), (4, 2), (8, 3)]:
        try:
            polys = boneh_durfee(m_, t_)
        except AssertionError as ex:
            print(f"[!] m={m_},t={t_}: {ex}")
            continue
        hit = None
        for i in range(len(polys)):
            if hit:
                break
            if not polys[i]:
                continue
            for j in range(i + 1, len(polys)):
                if not polys[j]:
                    continue
                hit = find_roots((polys[i], polys[j]))
                if hit:
                    break
        if hit:
            k, d, phi = hit
            break
    else:
        d = None

if not d:
    print("[-] stage 1 failed: no d recovered")
    sys.exit(2)

e = pow(e_c, d, e_n)
assert pow(e, e_e, e_n) == e_c, "e verification failed"
print(f"[+] d ({d.bit_length()} bits) = {d}")
print(f"[+] e ({e.bit_length()} bits) = {e}")
print(f"[+] stage 1 verified: pow(e, e_e, e_n) == e_c")

# ---------------------------------------------------------------- stage 2: Franklin-Reiter
def franklin_reiter(e0):
    """gcd(x^e0 - c, (n-x)^e0 - cc) mod nn -> m.  Feasible for small e0."""
    def pmul(a, b):
        r = [0] * (len(a) + len(b) - 1)
        for i, ai in enumerate(a):
            if ai:
                for j, bj in enumerate(b):
                    r[i + j] = (r[i + j] + ai * bj) % nn
        while r and r[-1] == 0:
            r.pop()
        return r

    def lin_pow(base):                       # (base - x)^e0
        r, b = [1], [base % nn, (-1) % nn]
        ee = e0
        while ee:
            if ee & 1:
                r = pmul(r, b)
            b = pmul(b, b)
            ee >>= 1
        return r

    def pdivmod(a, b):
        a = a[:]
        db = len(b) - 1
        inv = pow(b[db], -1, nn)             # non-invertible => factor of nn
        while len(a) - 1 >= db and a:
            da = len(a) - 1
            f = (a[da] * inv) % nn
            for i in range(db + 1):
                a[da - db + i] = (a[da - db + i] - f * b[i]) % nn
            while a and a[-1] == 0:
                a.pop()
        return a

    f1 = [0] * e0 + [1]
    f1[0] = (-c) % nn
    f2 = lin_pow(n)
    f2[0] = (f2[0] - cc) % nn
    while True:
        if len(f2) <= 1:
            return None
        r = pdivmod(f1, f2)
        f1, f2 = f2, r
        if len(f1) == 2:
            m = (-f1[0] * pow(f1[1], -1, nn)) % nn
            if pow(m, e0, nn) == c % nn and pow((n - m) % nn, e0, nn) == cc % nn:
                return m
            return None
        if len(f1) <= 1:
            return None

if e.bit_length() <= 12:
    m = franklin_reiter(e)
    if m:
        flag = m.to_bytes((m.bit_length() + 7) // 8, "big")
        print(f"[+] FLAG: {flag.decode(errors='replace')}")
        sys.exit(0)
    print("[-] stage 2: FR found no root for the recovered exponent")
    sys.exit(3)
else:
    print(f"[-] stage 2 BLOCKED: exponent e is {e.bit_length()} bits.")
    print("    Franklin-Reiter needs gcd(x^e - c, (n-x)^e - cc) over Z_nn[x],")
    print("    i.e. degree-e polynomials (~3e76 here). No known algorithm is")
    print("    subexponential in e for this composite modulus (open problem,")
    print("    Boneh, Twenty Years of Attacks on the RSA, section 4).")
    print("    Cross-checks done and failed: Wiener, factoring nn (p-1/p+1/rho/"
          "Fermat), prime reuse across all batch challenges, small-e sweep 3..811,")
    print("    exponent-reuse shortcuts, perfect powers.")
    sys.exit(4)
