#!/usr/bin/env python3
"""idol (REVERSE-05) — deterministic flag recovery, no attachment needed.

Forward chain in idol.pyc (CPython 3.9) on the 32-char slice flag[7:39]:
reverse -> xor-with-index -> seed(51) noise (-randint(0,5) on even index,
+randint(0,5) on odd index) -> reverse -> pair-swap -> RC4 with key
hex(crc32(IDOL)) and an extra ^len(data)==32 -> compared to flag.txt.
This script inverts it with the constants recovered from the pyc + flag.txt.
"""
import random
import string
import zlib

# expected ciphertext: the bytes repr stored in flag.txt (32 bytes)
TARGET = bytes.fromhex(
    "84f30736ce78123aa4402f505aec4ed0"
    "8d9e019ea487a97801773c48e9aa1333"
)

# stage-1 gate in idol0: give_me_string(IDOL) must equal these 7 bytes
GATE = bytes([0x16, 0x17, 0x06, 0x53, 0x0D, 0x50, 0x15])


def ksa(key: bytes) -> list:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    return s


# recover the idol name, the only value that passes the stage-1 check
random.seed(35)
characters = string.ascii_letters + string.digits + string.punctuation
pad = "".join(characters[random.randrange(0, len(GATE))] for _ in range(len(GATE)))
IDOL = "".join(chr(GATE[i] ^ ord(pad[i])) for i in range(len(GATE)))
KEY = format(zlib.crc32(IDOL.encode()), "x").encode()
print("[+] IDOL       :", IDOL)
print("[+] RC4 key    :", KEY.decode())

# invert idol5: RC4-XOR stream with an extra ^ len(data) == 32
s = ksa(KEY)
i = j = 0
res = bytearray()
for c in TARGET:
    i = (i + 1) % 256
    j = (j + s[i]) % 256
    s[i], s[j] = s[j], s[i]
    res.append(c ^ s[(s[i] + s[j]) % 256] ^ 32)
res = bytes(res)
print("[+] idol3 out  :", res.hex())

# invert idol3: pair-swap (res[2k] = w[2k+1]) then reverse
w = bytes(v for k in range(0, len(res), 2) for v in (res[k + 1], res[k]))
t = w[::-1]

# invert idol2: seed(51) noise, even index had -randint, odd index had +randint
random.seed(51)
rands = [random.randint(0, 5) for _ in range(len(t))]
d = bytes(t[q] + rands[q] if q % 2 == 0 else t[q] - rands[q] for q in range(len(t)))

# invert idol1 xor-with-index, then the idolTop reversal
flag = bytes(d[q] ^ q for q in range(len(d)))[::-1].decode()
print("[+] FLAG       :", flag)
