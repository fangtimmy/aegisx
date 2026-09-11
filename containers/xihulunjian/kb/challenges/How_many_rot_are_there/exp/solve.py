#!/usr/bin/env python3
"""How_many_rot_are_there (CRYPTO-02) — deterministic flag recovery.

RSA with e=2^16. hint=(e*p+e^2)^q mod n leaks the factorization; the printable
e-th root is ROT18 (ROT13 letters + ROT5 digits — the title answers "how many
rot": two) of the flag. Constants below are from the original attachment.
"""
from itertools import product
from math import gcd

hint = 101048855492044571417475830924088947184757234444475406804947498377420789778570832667138477666669908690663759417316798982038542431531087217671616502327573935462498550576600180793553880691247281813287212166428236802504214599757066100450668324529765827891463527861160593648623157792143035729770978865516948880313
c = 62214676810380175097525195047581624344610596576389901532958749194333175927146005969879818861882074690471600028484419966943711467342568120045965690332607166015419112255944582319675084071747302548088333383655637474764450810187215177625206094644430662667402073753343732910706186228919546522301643978766618493433
n = 131232786046474875167899992758388342524496883222860498694293714537118780151392850883679257361099172761516964104115167485944225089583991161038144993589322315250529302275646269196618503385962458635181473103926087951239559460161218447795578503981054097990206859884036249764383918404640987230150854235563692800669
e = 65536

p = gcd((pow(e, 2 * n, n) - hint) % n, n)
q = n // p
assert p > 1 and p * q == n


def all_eroots(a: int, mod: int, e: int) -> list[int]:
    g = gcd(e, mod - 1)
    assert pow(a, (mod - 1) // g, mod) == 1
    u = pow(e, -1, (mod - 1) // g)
    x0 = pow(a, u, mod)
    assert pow(x0, e, mod) == a
    z = 2
    while True:
        h = pow(z, (mod - 1) // g, mod)
        if pow(h, g, mod) == 1 and (g == 1 or pow(h, g // 2, mod) != 1):
            break
        z += 1
    return [x0 * pow(h, j, mod) % mod for j in range(g)]


def to_bytes(m: int) -> bytes:
    return m.to_bytes((m.bit_length() + 7) // 8, "big")


rp, rq = all_eroots(c % p, p, e), all_eroots(c % q, q, e)
printable = []
for a, b in product(rp, rq):
    m = (a * pow(q, -1, p) * q + b * pow(p, -1, q) * p) % n
    assert pow(m, e, n) == c
    mb = to_bytes(m)
    if all(32 <= x < 127 for x in mb):
        printable.append(mb)


def rot18(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        if "A" <= ch <= "Z":
            out.append(chr((o - 65 + 13) % 26 + 65))
        elif "a" <= ch <= "z":
            out.append(chr((o - 97 + 13) % 26 + 97))
        elif "0" <= ch <= "9":
            out.append(chr((o - 48 + 5) % 10 + 48))
        else:
            out.append(ch)
    return "".join(out)


flag = rot18(printable[0].decode())
print("[+] FLAG :", flag)
print("[+] submit:", flag[flag.index("{") + 1:flag.index("}")])
