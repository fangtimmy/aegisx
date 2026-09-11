#!/usr/bin/env python3
"""gogogo_3 (REVERSE-01) — deterministic flag recovery, no attachment needed.

Forward chain in the binary: RC4 -> XOR -> AES-128-CBC -> hex compare.
This script inverts it with the constants recovered from the unpacked binary.
"""
from Crypto.Cipher import AES

TARGET = bytes.fromhex(
    "1c1c18f8fc5b6c3d36a3fb8893561a90"
    "6a9fa69c523ac6d3160adbe85e19fee8"
)

AES_KEY = b"qwertyuiopasdfgh"
AES_IV = b"1234567890zxcvbn"
XOR_KEY = b"fmyy123"
RC4_KEY = b"mysecretkey"


def rc4(data: bytes, key: bytes) -> bytes:
    S = list(range(256))
    j = 0
    for i in range(256):
        j = (j + S[i] + key[i % len(key)]) & 0xFF
        S[i], S[j] = S[j], S[i]
    i = j = 0
    out = bytearray()
    for c in data:
        i = (i + 1) & 0xFF
        j = (j + S[i]) & 0xFF
        S[i], S[j] = S[j], S[i]
        out.append(c ^ S[(S[i] + S[j]) & 0xFF])
    return bytes(out)


stage2 = AES.new(AES_KEY, AES.MODE_CBC, AES_IV).decrypt(TARGET)
print("[+] AES decrypt :", stage2.hex())

rc4_cipher = bytes(c ^ XOR_KEY[i % len(XOR_KEY)] for i, c in enumerate(stage2))
print("[+] RC4 cipher  :", rc4_cipher.hex())

flag = rc4(rc4_cipher, RC4_KEY)
print("[+] FLAG        :", flag.decode())
