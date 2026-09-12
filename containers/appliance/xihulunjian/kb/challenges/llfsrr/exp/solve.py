#!/usr/bin/env python3
"""llfsrr (CRYPTO-03) — deterministic flag recovery, no attachment needed.

key file = flag bits XOR LFSR keystream. LFSR: state_0 = 1,
out_j = parity(state_j & feedback_mask), state_{j+1} = ((state_j << 1) & 0xffffffff) ^ out_j.
The known flag prefix "DASCTF{" yields enough known keystream bits that each one is a
linear GF(2) equation in the 32 unknown mask bits (state_j is computable from the
outputs alone). Gaussian elimination recovers the mask; running the LFSR forward
decrypts the key. Pure stdlib.
"""

KEY = (
    "0110110010011011010100001001110010000010010110011010000011101000"
    "1100100001100001110100001000000110011111001110000000000001010011"
    "0010001010110101111101100010001101011001010000111000011111001001"
    "0011111010010001100011111101000100100010010000001001010100111011"
    "010011000010111001010001011100011001100010000010011011011111000"
)
PREFIX = b"DASCTF{"


def solve_mask() -> int:
    # binary_flag = bin(bytes_to_long(flag))[2:]; its first len(pb) bits are the
    # prefix (the leading zero bit of 0x44 is dropped, exactly as in encryption).
    pb = bin(int.from_bytes(PREFIX, "big"))[2:]
    state, rows = 1, []
    for i, b in enumerate(pb):
        out = int(KEY[i]) ^ int(b)
        rows.append((state, out))  # parity(state & mask) == out
        state = ((state << 1) & 0xFFFFFFFF) ^ out
    M = [[(r >> j) & 1 for j in range(32)] + [v] for r, v in rows]
    rank, piv = 0, []
    for col in range(32):
        sel = next((rr for rr in range(rank, len(M)) if M[rr][col]), None)
        if sel is None:
            continue
        M[rank], M[sel] = M[sel], M[rank]
        for rr in range(len(M)):
            if rr != rank and M[rr][col]:
                M[rr] = [a ^ b for a, b in zip(M[rr], M[rank])]
        piv.append(col)
        rank += 1
    assert rank == 32, f"underdetermined (rank {rank})"
    assert all(M[rr][32] == 0 for rr in range(rank, len(M))), "prefix inconsistent"
    return sum(M[i][32] << col for i, col in enumerate(piv))


def decrypt(mask: int) -> bytes:
    state, bits = 1, []
    for c in KEY:
        xb = bin(state & mask).count("1") & 1
        bits.append(int(c) ^ xb)
        state = ((state << 1) & 0xFFFFFFFF) ^ xb
    l = int("".join(map(str, bits)), 2)
    return l.to_bytes((l.bit_length() + 7) // 8, "big")


mask = solve_mask()
print("[+] feedback_mask :", hex(mask))

flag = decrypt(mask)
assert flag.startswith(PREFIX) and flag.endswith(b"}"), flag
print("[+] FLAG          :", flag.decode())
print(flag[7:-1].decode())
