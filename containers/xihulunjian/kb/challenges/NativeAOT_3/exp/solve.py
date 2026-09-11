#!/usr/bin/env python3
"""NativeAOT_3 (REVERSE-03) — deterministic flag recovery, no attachment needed.

Checker logic (NAOT.exe, .NET 8 NativeAOT x64; symbols from the shipped NAOT.pdb):
  Main:   input must be DASCTF{<32 chars>}; body = input.Substring(7, len - 8).
  IsFlag: for each body byte push (b & 0xf) then (b >> 4) onto a Stack,
          then pop 64 values comparing each to expected[i] from FlagHandle.
  FlagHandle ctor: expected[i] = FlagBit_i.SetBit(i).GetBit(); every FlagBit_i
          chains its parent's SetBit then XORs one immediate constant (chain
          roots at i = 0/16/32/48), so expected[i] = i ^ (chain XOR constant).
  Popping reverses push order: flag[31-k] = (expected[2k] << 4) | (expected[2k+1]).

The 64 reference nibbles below were recovered once from the PDB-named SetBit
functions and confirmed dynamically against the binary ("Yes, you're right!").
"""

EXPECTED = [
    6, 13, 6, 6, 6, 12, 7, 9,
    7, 3, 5, 10, 6, 15, 5, 6,
    5, 9, 4, 6, 6, 6, 4, 7,
    5, 7, 5, 5, 3, 0, 4, 4,
    6, 4, 4, 1, 6, 4, 6, 2,
    3, 8, 5, 2, 7, 2, 6, 2,
    7, 3, 4, 12, 4, 7, 4, 13,
    6, 13, 6, 13, 5, 1, 4, 15,
]

flag = bytearray(32)
for k in range(32):
    flag[31 - k] = (EXPECTED[2 * k] << 4) | EXPECTED[2 * k + 1]

print(flag.decode())
