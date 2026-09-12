#!/usr/bin/env python3
"""zistel (REVERSE-08, Zig static ELF) — deterministic flag recovery.

The 11KB stripped binary checks 16 input bytes through a 20-round Feistel
cipher keyed by the dword "love"; transform(flag16) == key16 with the key
bytes below (0x1000730). Decrypt the key with reversed rounds.
"""
MASK = 0xFFFFFFFF

seed = 0x65766F6C  # dword "love" at .data 0x1004790
w = [0] * 20
w[0] = seed ^ 0xDEADBEEF
w[1] = w[0] ^ 0xBEEFDEAD
for i in range(2, 20):
    w[i] = w[i - 2] ^ w[i - 1]


def swap4(a: int, wk: int) -> int:
    """Byte permutation driven by key bytes (0x100261b swap loop)."""
    ab = list(a.to_bytes(4, "little"))
    kb = wk.to_bytes(4, "little")
    for i in range(4):
        j = kb[i] & 3
        ab[i], ab[j] = ab[j], ab[i]
    return int.from_bytes(bytes(ab), "little")


def g(r: int, wk: int) -> int:
    return (swap4(r ^ wk, wk) ^ wk) & MASK


def enc(b8: bytes) -> bytes:
    L = int.from_bytes(b8[0:4], "little")
    R = int.from_bytes(b8[4:8], "little")
    for i in range(20):
        L, R = R, (L ^ g(R, w[i])) & MASK
    return R.to_bytes(4, "little") + L.to_bytes(4, "little")


def dec(b8: bytes) -> bytes:
    L = int.from_bytes(b8[4:8], "little")
    R = int.from_bytes(b8[0:4], "little")
    for i in range(19, -1, -1):
        L, R = (R ^ g(L, w[i])) & MASK, L
    return L.to_bytes(4, "little") + R.to_bytes(4, "little")


key = bytes.fromhex("5831293311027660465f1842296f7463")
plain = dec(key[0:8]) + dec(key[8:16])
assert enc(plain[0:8]) + enc(plain[8:16]) == key, "round-trip mismatch"
print("[+] FLAG :", "DASCTF{%s}" % plain.decode())
