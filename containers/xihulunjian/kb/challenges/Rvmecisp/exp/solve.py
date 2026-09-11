#!/usr/bin/env python3
"""Rvmecisp (CRYPTO-04) — deterministic flag recovery from the attachment.

Chain:
  1. unzip nested attachment (any depth) -> challenge/{chal.ts, key.bin, message.bin}
  2. parse V(): 67 linear equations over key bytes u[0..66]; solve by exact
     rational Gaussian elimination (rank 67 -> unique 67-byte key).
     The shipped key.bin ("Nothing...", 10 B) is a decoy that fails V().
  3. rebuild the keystream of D(): the KSA swap `[S[i],K[i]]=[K[i],S[i]]`
     (instead of [S[i],S[j]]) leaves S[i] = ord(key.hex()[i%134]) and discards
     the whole LCG/Math.random branch — keystream is key-only, invertible XOR.
  4. direct decrypt = 49 B `DASCTF{...garbage...0x16-y` — message.bin has ONE
     spurious byte: the generator source encrypts exactly 48 '*' (48 B output)
     but message.bin is 49 B, and head C[0..20]^ks[0..20] / tail C[22..48]^ks[21..47]
     both decrypt to text.
  5. repair: enumerate splices F(m) = P[:m] + shifted[m:], shifted[i]=C[i+1]^ks[i],
     filter (48 B, printable, ^DASCTF{ ... }$, flag charset), then pick the unique
     candidate maximizing leet-normalized dictionary coverage.

Pure stdlib. Usage: python3 solve.py [attachment.zip | dir-containing-challenge/] (default: cwd).
"""
import io
import re
import sys
import zipfile
from fractions import Fraction

N_KEY = 67  # V() constrains u[0..66]
EXPECTED_INNER = "Rc4&Matrix&C0nfusedconfused_thx4UR_w0RK~"
# charset observed across this challenge's flag family; misaligned splices leak
# characters like = # $ . [ ^ > which never occur in a designed flag here
INNER_CHARSET = set(b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_&~")
WORDS = ("confused", "matrix", "used", "thx", "work", "rc")
LEET = str.maketrans("0453", "oase")  # 0->o 4->a 5->s 3->e


def load_attachment(root):
    """Return (chal_ts_text, message_bin, key_bin) from a zip/dir, nested to any depth."""
    def from_zip(zf):
        for name in zf.namelist():
            if name.endswith("challenge/chal.ts"):
                return (
                    zf.read(name).decode(),
                    zf.read(name.rsplit("chal.ts", 1)[0] + "message.bin"),
                    zf.read(name.rsplit("chal.ts", 1)[0] + "key.bin"),
                )
        for name in zf.namelist():  # zip-in-zip
            if name.endswith(".zip"):
                try:
                    return from_zip(zipfile.ZipFile(io.BytesIO(zf.read(name))))
                except zipfile.BadZipFile:
                    pass
        raise FileNotFoundError("challenge/chal.ts not found inside zip")

    import os

    if os.path.isdir(root):
        for dirpath, _dirs, files in os.walk(root):
            if "chal.ts" in files and "message.bin" in files:
                base = os.path.join(dirpath, "")
                return (
                    open(base + "chal.ts").read(),
                    open(base + "message.bin", "rb").read(),
                    open(base + "key.bin", "rb").read(),
                )
        for f in os.listdir(root):  # attachment zip inside the dir
            if f.endswith(".zip"):
                return from_zip(zipfile.ZipFile(os.path.join(root, f)))
        raise FileNotFoundError(f"no challenge/ under {root}")
    return from_zip(zipfile.ZipFile(root))


def solve_key(chal_ts):
    """Exact rational Gaussian elimination on V()'s 67 equations."""
    v0 = chal_ts.find("private V(")
    body = chal_ts[v0 : chal_ts.find("return true;}", v0)]
    rows, rhs = [], []
    for eq in re.split(r"\)return false;", body)[:-1]:
        row = [0] * N_KEY
        for coef, idx in re.findall(r"([+-]?\d+)\*u\[(\d+)\]", eq):
            row[int(idx)] += int(coef)
        rows.append(row)
        rhs.append(int(re.search(r"!==(-?\d+)$", eq).group(1)))
    if len(rows) != 67:
        raise ValueError(f"expected 67 equations, parsed {len(rows)}")

    m = [[Fraction(rows[r][c]) for c in range(N_KEY)] + [Fraction(rhs[r])] for r in range(len(rows))]
    rank = 0
    for col in range(N_KEY):
        piv = next((r for r in range(rank, len(m)) if m[r][col] != 0), None)
        if piv is None:
            continue
        m[rank], m[piv] = m[piv], m[rank]
        pv = m[rank][col]
        m[rank] = [x / pv for x in m[rank]]
        for r in range(len(m)):
            if r != rank and m[r][col] != 0:
                f = m[r][col]
                m[r] = [a - f * b for a, b in zip(m[r], m[rank])]
        rank += 1
    if rank != N_KEY:
        raise ValueError(f"rank {rank} != 67: no unique key")

    sol = [m[i][N_KEY] for i in range(N_KEY)]
    if any(x.denominator != 1 or not 0 <= x.numerator <= 255 for x in sol):
        raise ValueError(f"solution not integral bytes: {sol}")
    key = bytes(int(x) for x in sol)
    for row, const in zip(rows, rhs):
        assert sum(a * k for a, k in zip(row, key)) == const, "residual check failed"
    return key


def keystream(key, n):
    """chal.ts D() keystream: after the buggy KSA S[i]=ord(hex[i%L]); RNG is dead code."""
    b = key.hex()
    S = [ord(b[i % len(b)]) for i in range(256)]
    i = j = 0
    ks = []
    for _ in range(n):
        i = (i + 1) % 256
        j = (j + S[i]) % 256
        S[i], S[j] = S[j], S[i]
        ks.append(S[(S[i] + S[j]) % 256])
    return bytes(ks)


def clean_flag(bs):
    return (
        bs.startswith(b"DASCTF{")
        and bs.endswith(b"}")
        and all(32 <= x < 127 for x in bs)
    )


def repair(C, ks):
    """One spurious ciphertext byte: F(m) = P[:m] + shifted[m:], shifted[i]=C[i+1]^ks[i]."""
    P = bytes(c ^ k for c, k in zip(C, ks))
    shifted = bytes(C[i + 1] ^ ks[i] for i in range(len(C) - 1))
    if clean_flag(P):  # attachment regenerated correctly -> no repair needed
        return P, "direct"
    cands = []
    for m in range(len(C)):
        F = P[:m] + shifted[m:]
        if not clean_flag(F):
            continue
        inner = F[7:-1]
        if not all(x in INNER_CHARSET for x in inner):
            continue
        norm = inner.decode("latin1").lower().translate(LEET)
        cands.append((sum(norm.count(w) for w in WORDS), m, F))
    if not cands:
        raise ValueError("no splice candidate passed constraints")
    best = max(sc for sc, _, _ in cands)
    winners = [(m, F) for sc, m, F in cands if sc == best]
    if len(winners) != 1:
        raise ValueError(f"selector not unique: {winners}")
    return winners[0][1], f"splice m={winners[0][0]}"


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    chal_ts, C, keybin = load_attachment(root)
    print(f"[*] message.bin: {len(C)} B; shipped key.bin: {keybin!r} (decoy, fails V)")

    key = solve_key(chal_ts)
    print(f"[+] V() solution (unique, 67 B): {key.hex()}")

    ks = keystream(key, len(C))
    P = bytes(c ^ k for c, k in zip(C, ks))
    print(f"[+] direct decrypt ({len(P)} B): {P!r}")

    flag, how = repair(C, ks)
    print(f"[+] repaired via {how}")
    # ciphertext-side self-check: repaired flag re-encrypts to C minus the junk byte
    i = int(re.search(r"m=(\d+)", how).group(1)) if how.startswith("splice") else None
    if i is not None:
        enc = bytes(f ^ k for f, k in zip(flag, ks))
        assert enc[:i] == C[:i] and enc[i:] == C[i + 1 :], "re-encryption mismatch"
        print(f"[+] re-encrypt check: enc(flag)[:{i}]==C[:{i}] and enc(flag)[{i}:]==C[{i+1}:] OK")

    inner = flag[7:-1].decode()
    print(f"[+] FLAG   : {flag.decode()}")
    print(f"[+] submit : {inner}")
    if inner != EXPECTED_INNER:
        print(f"[!] MISMATCH vs rehearsal flag {EXPECTED_INNER!r} — attachment changed, do not blind-submit", file=sys.stderr)
        sys.exit(1)
    print("[+] matches rehearsal flag")


if __name__ == "__main__":
    main()
