#!/usr/bin/env python3
"""nanomites (REVERSE-04) — deterministic flag recovery.

Self-debugging PE: the check blob (file offset 0x10620, len 0x3f8e) holds 440
ud2 sites; the 44 with r13==1 carry one expected hash per input byte. Brute
force each byte against the parent's hashlittle-style hash. Reads the exe
from ./nanomites.exe or straight out of the attachment zip in CWD.
"""
import io
import re
import zipfile
from pathlib import Path

M32 = 0xFFFFFFFF
BLOB_OFF, BLOB_LEN = 0x10620, 0x3F8E


def load_blob() -> bytes:
    exes = [p for p in Path(".").rglob("*") if p.is_file() and p.name.lower() == "nanomites.exe"]
    if not exes:
        zips = [p for p in Path(".").rglob("*.zip") if "nanomites" in p.name.lower()] or \
               [p for p in Path(".").rglob("*.zip")]
        assert zips, "nanomites.exe or attachment zip not found under CWD"
        with zipfile.ZipFile(zips[0]) as z:
            name = next(n for n in z.namelist() if n.lower().endswith(".exe"))
            data = z.read(name)
    else:
        data = exes[0].read_bytes()
    return data[BLOB_OFF:BLOB_OFF + BLOB_LEN]


def shl(x: int, n: int) -> int:
    return (x << n) & M32


def shr(x: int, n: int) -> int:
    return (x >> n) & M32


def hash_byte(b: int) -> int:
    """hash(0x401584) over the 1-byte NUL-terminated string [b, 0]."""
    a = 1
    a = (a + b) & M32
    a ^= shl(a, 10)
    a = (a + shr(a, 1)) & M32
    a ^= shl(a, 3)
    a = (a + shr(a, 5)) & M32
    a ^= shl(a, 4)
    a = (a + shr(a, 17)) & M32
    a ^= shl(a, 25)
    a = (a + shr(a, 6)) & M32
    return a


def ror64(x: int, n: int) -> int:
    n %= 64
    return ((x >> n) | (x << (64 - n))) & ((1 << 64) - 1)


def main() -> None:
    blob = load_blob()
    sites = []
    i = 0
    while True:
        m = re.search(rb"\x0f\x0b", blob[i:])
        if not m:
            break
        ud2pos = i + m.start()
        prev = blob[max(0, ud2pos - 96):ud2pos]
        r13 = r11 = None
        for k in range(len(prev) - 9, -1, -1):
            if prev[k:k + 2] == b"\x49\xbd":
                r13 = int.from_bytes(prev[k + 2:k + 10], "little")
                break
        for k in range(len(prev) - 9, -1, -1):
            if prev[k:k + 2] == b"\x49\xbb":
                r11 = int.from_bytes(prev[k + 2:k + 10], "little")
                break
        off = None
        for k in range(len(prev) - 3, -1, -1):
            if prev[k:k + 2] == b"\x44\x8a":
                if prev[k + 2] == 0x21:
                    off = 0
                elif prev[k + 2] == 0x61:
                    off = prev[k + 3]
                if off is not None:
                    break
        sites.append((ud2pos, off, r11, r13))
        i = ud2pos + 2

    ones = sorted((s for s in sites if s[3] == 1), key=lambda s: s[1])
    assert len(ones) == 44 and [s[1] for s in ones] == list(range(44)), "site layout mismatch"
    flag = []
    for ud2pos, off, imm, _ in ones:
        exp = ror64(imm ^ 0x1337, 13) & M32
        cands = [c for c in range(256) if hash_byte(c) == exp]
        assert len(cands) == 1, (off, exp, cands)
        flag.append(chr(cands[0]))
    full = "".join(flag)
    print("[+] FLAG :", full)
    print("[+] submit:", full[7:-1] if full.startswith("DASCTF{") else full)


if __name__ == "__main__":
    main()
