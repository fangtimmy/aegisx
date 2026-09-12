#!/usr/bin/env python3
"""QAQTAT (CRYPTO-08) — matrix key-transport over GF(p^2), 3x3, Cayley-Hamilton break.

Scheme: Q,A random non-commuting 3x3 matrices over GF(p^2); T = Q*A*Q;
S = T*A*T; G = Q^r1 public. enc: D = G^s, E = A*T*A, publish F = D*E*D;
session key = sum of all 9 entries of K = D*S*D, mask = sha256(str(key)).

Break: by Cayley-Hamilton D = G^s lies in span{I, G, G^2}, so with unknown
a = (a0,a1,a2):  F = sum_{i,j} (a_i a_j) G^i E G^j — LINEAR in the rank-1
matrix X = a a^T. Solve the unique 9x9 system over GF(p^2), read a (up to
sign, irrelevant since D appears on both sides) from a nonzero column,
recover the scale a_k^2 from F, then K = (Dv S Dv)/a_k^2 exactly.

Pure Python stdlib. Finds chall.sage recursively from CWD
(unzip QAQTAT的附件.zip first: it contains tempdir/CRYPTO附件/chall.sage).
"""
import ast
import hashlib
import re
import sys
from pathlib import Path

# ---------------- GF(p^2), i^2 = -1; element = (const, i-coeff) ----------------
P = None
ZERO = (0, 0)
ONE = (1, 0)


def f2_add(u, v):
    return ((u[0] + v[0]) % P, (u[1] + v[1]) % P)


def f2_sub(u, v):
    return ((u[0] - v[0]) % P, (u[1] - v[1]) % P)


def f2_mul(u, v):
    return ((u[0] * v[0] - u[1] * v[1]) % P, (u[0] * v[1] + u[1] * v[0]) % P)


def f2_inv(u):
    ni = pow((u[0] * u[0] + u[1] * u[1]) % P, -1, P)
    return ((u[0] * ni) % P, (-u[1] * ni) % P)


def f2_div(u, v):
    return f2_mul(u, f2_inv(v))


def m_mul(X, Y):
    Z = [[ZERO] * 3 for _ in range(3)]
    for r in range(3):
        for c in range(3):
            acc = ZERO
            for k in range(3):
                acc = f2_add(acc, f2_mul(X[r][k], Y[k][c]))
            Z[r][c] = acc
    return Z


def m_id():
    return [[ONE if r == c else ZERO for c in range(3)] for r in range(3)]


def m_add(X, Y):
    return [[f2_add(X[r][c], Y[r][c]) for c in range(3)] for r in range(3)]


def m_scale(X, s):
    return [[f2_mul(X[r][c], s) for c in range(3)] for r in range(3)]


def m_pow(M, e):
    R, B = m_id(), M
    while e:
        if e & 1:
            R = m_mul(R, B)
        B = m_mul(B, B)
        e >>= 1
    return R


# ---------------- parsing of Sage-printed structures ----------------
ELEM_RE = re.compile(r'(\d+)\*i \+ (\d+)|(\d+)\*i|(\d+)')


def parse_struct(s):
    """Sage-printed nested list/tuple of GF(p^2) elements -> nested Python
    containers whose leaves are (const, i-coeff) pairs."""
    tokens = []

    def rep(m):
        if m.group(1) is not None:
            tokens.append((int(m.group(2)), int(m.group(1))))  # a*i + b -> (b, a)
        elif m.group(3) is not None:
            tokens.append((0, int(m.group(3))))                # a*i    -> (0, a)
        else:
            tokens.append((int(m.group(4)), 0))                # b      -> (b, 0)
        return "@%d@" % (len(tokens) - 1)

    skel = ELEM_RE.sub(rep, s)
    for idx, (a, b) in enumerate(tokens):
        skel = skel.replace("@%d@" % idx, "(%d,%d)" % (a, b))
    return ast.literal_eval(skel)


def to_m(x):
    return [[tuple(e) for e in row] for row in x]


# ---------------- linear solve over GF(p^2) (square, unique case) ----------------
def solve_linear(cols, rhs):
    n = len(cols)
    M = [[cols[c][j] for c in range(n)] + [rhs[j]] for j in range(n)]
    where = [-1] * n
    row = 0
    for col in range(n):
        piv = next((r for r in range(row, n) if M[r][col] != ZERO), None)
        if piv is None:
            return None
        M[row], M[piv] = M[piv], M[row]
        inv = f2_inv(M[row][col])
        M[row] = [f2_mul(v, inv) for v in M[row]]
        for r in range(n):
            if r != row and M[r][col] != ZERO:
                f = M[r][col]
                M[r] = [f2_sub(M[r][c], f2_mul(f, M[row][c])) for c in range(n + 1)]
        where[col] = row
        row += 1
    return [M[where[c]][n] for c in range(n)]


# ---------------- Sage str() replication for GF(p^2) elements ----------------
def sage_str(z):
    a, b = z[1], z[0]  # a = i-coefficient, b = constant
    if a == 0 and b == 0:
        return "0"
    if a == 0:
        return str(b)
    if b == 0:
        return "%d*i" % a
    return "%d*i + %d" % (a, b)


def main():
    global P
    cands = sorted(Path(".").rglob("chall.sage"))
    assert cands, "chall.sage not found under CWD (unzip QAQTAT的附件.zip first)"
    txt = cands[0].read_text()

    # only the printed-output block inside the triple-quoted docstring
    parts = txt.split('"""')
    out = next(s for s in reversed(parts)
               if "ct = " in s and re.search(r'^p\s*=\s*\d', s, re.M))

    P = int(re.search(r'^p\s*=\s*(\d+)', out, re.M).group(1))
    ct = int(re.search(r'^ct\s*=\s*(\d+)', out, re.M).group(1))
    pk = parse_struct(re.search(r'^pk\s*=\s*(\(.*?\))\s*$', out, re.M | re.S).group(1))
    A, T, S, G = [to_m(x) for x in pk]
    F = to_m(parse_struct(re.search(r'^F\s*=\s*(\[.*?\])\s*$', out, re.M | re.S).group(1)))
    print("[+] parsed: p bits=%d, ct bits=%d" % (P.bit_length(), ct.bit_length()))

    E = m_mul(A, m_mul(T, A))  # = A*T*A, fully public

    # 9x9 system: sum X_ij (G^i E G^j) = F, X = a a^T
    Gp = [m_id(), G, m_pow(G, 2)]
    cols = []
    for i in range(3):
        for j in range(3):
            Mij = m_mul(Gp[i], m_mul(E, Gp[j]))
            cols.append([Mij[r][c] for r in range(3) for c in range(3)])
    X = solve_linear(cols, [F[r][c] for r in range(3) for c in range(3)])
    assert X is not None, "9x9 system singular (unexpected for this instance)"
    print("[+] 9x9 linear system solved (unique X)")

    # column k of X = a_k * a  ->  Dv = a_k * D
    k = next(c for c in range(3) if any(X[i * 3 + c] != ZERO for i in range(3)))
    v = [X[r * 3 + k] for r in range(3)]
    Dv = m_add(m_add(m_scale(m_id(), v[0]), m_scale(G, v[1])), m_scale(Gp[2], v[2]))

    # a_k^2 = (Dv E Dv)[r][c] / F[r][c]; K = (Dv S Dv) / a_k^2
    R = m_mul(Dv, m_mul(E, Dv))
    pairs = [(r, c) for r in range(3) for c in range(3) if F[r][c] != ZERO]
    r0, c0_ = pairs[0]
    c0 = f2_div(R[r0][c0_], F[r0][c0_])
    assert all(f2_div(R[r][c], F[r][c]) == c0 for r, c in pairs), "scale inconsistent"
    K = m_scale(m_mul(Dv, m_mul(S, Dv)), f2_inv(c0))
    print("[+] K = D*S*D recovered (scale checks consistent)")

    key = ZERO
    for r in range(3):
        for c in range(3):
            key = f2_add(key, K[r][c])
    mask = int(hashlib.sha256(sage_str(key).encode()).hexdigest(), 16)
    m = ct ^ mask
    flag = m.to_bytes((m.bit_length() + 7) // 8, "big")
    print("[+] FLAG :", flag.decode())


if __name__ == "__main__":
    main()
