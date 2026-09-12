#!/usr/bin/env python3
"""特殊流量 (MISC-04) — pcap upload forensics.

1. POST 上传的 flag 文件是「hex 字符串整体逆序」的 7z（逆序后开头 377abcaf271c）。
2. 用初赛实证密码 PAS4_Wo3d_he3e! 解压得 flag.txt（内置常量，同 sm4rev 模式）。
3. flag.txt 的 token：大写字母保留，其余按 32 进制转字符；再解两栏栅栏（列移位，
   n = 长度一半）得 flag。

Needs: tshark, 7z (in the image). Run from the directory holding Traffic.pcapng.
"""
import re
import subprocess
import tempfile
from pathlib import Path

work = Path(tempfile.mkdtemp(prefix="traffic-"))

pcaps = sorted(Path(".").rglob("*.pcapng")) + sorted(Path(".").rglob("*.pcap"))
assert pcaps, "pcap not found under CWD"

r = subprocess.run(
    ["tshark", "-r", str(pcaps[0]), "-Y", "http.request.method == POST",
     "-T", "fields", "-e", "tcp.payload"],
    capture_output=True, text=True)
raw = b"".join(bytes.fromhex(ln.replace(":", "")) for ln in r.stdout.splitlines() if ln.strip())

m = re.search(rb'filename="flag"[\s\S]*?\r\n\r\n(.*?)\r\n------', raw)
assert m, 'upload of filename="flag" not found'
hexstr = m.group(1).decode().strip()
data = bytes.fromhex(hexstr[::-1])
assert data[:6] == bytes.fromhex("377abcaf271c"), "reversed hex is not a 7z"
sz = work / "flag.7z"
sz.write_bytes(data)
print(f"[+] 7z rebuilt ({len(data)} bytes)")

out = work / "out"
rp = subprocess.run(["7z", "x", "-pPAS4_Wo3d_he3e!", f"-o{out}", str(sz)], capture_output=True)
assert rp.returncode == 0, "7z extraction failed (password changed?)"
txt = next(out.rglob("flag.txt")).read_text()
print("[+] flag.txt:", txt.strip()[:80], "...")

s = "".join(t if t.isupper() else chr(int(t, 32)) for t in txt.split())


def col_dec(ct, n):
    L = len(ct)
    out = [""] * L
    base = 0
    for k in range(n):
        cnt = len(range(k, L, n))
        out[k::n] = ct[base:base + cnt]
        base += cnt
    return "".join(out)


for n in range(2, len(s)):
    dec = col_dec(s, n)
    if re.fullmatch(r"DASCTF\{[0-9a-f-]+\}", dec):
        print(f"[+] rail n = {n}")
        print("[+] FLAG :", dec)
        break
else:
    raise SystemExit(f"[-] fence decode failed on {s!r}")
