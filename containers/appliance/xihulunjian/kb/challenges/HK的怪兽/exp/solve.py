#!/usr/bin/env python3
"""HK的怪兽 (MISC-03) — Godzilla webshell forensics, full chain from pcap.

Chain (all values derived from the pcap, nothing hardcoded except heuristics):
  1. shell.php uploaded via DVWA contains the config in cleartext:
     `$pass='DASCTF'; ... $key='<16-hex>';`  -> key.
  2. flag.zip (AES) in the attachment opens with that key -> `flag` blob.
  3. Some stream's response (Godzilla: hex16 + b64 -> XOR key -> gzip) contains
     a hex dump of another AES zip holding 1.pem.
  4. Its password is the txt filename from a decrypted `cat <name>.txt` request.
  5. openssl pkeyutl -decrypt -in flag -inkey 1.pem -> flag.

Needs: tshark, 7z, openssl (all in the image). Run from the directory holding
dasdas.pcapng + flag.zip (unzipped attachment).
"""
import base64
import re
import subprocess
import tempfile
import urllib.parse
import zlib
from pathlib import Path

work = Path(tempfile.mkdtemp(prefix="hkmonster-"))


def sh(*cmd, **kw):
    return subprocess.run(cmd, capture_output=True, **kw)


def xkey(d, key):
    return bytes(d[i] ^ key[(i + 1) & 15] for i in range(len(d)))


def gunzip_tolerant(d):
    try:
        return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(d)
    except zlib.error:
        return None


pcaps = sorted(Path(".").rglob("*.pcapng")) + sorted(Path(".").rglob("*.pcap"))
assert pcaps, "pcap not found under CWD"
pcap = str(pcaps[0])

# ---- 1. key from uploaded shell.php ----
raw = Path(pcap).read_bytes()
m = re.search(rb"\$key\s*=\s*'([0-9a-fA-F]{16})'", raw)
assert m, "key not found in pcap (shell.php upload)"
key = m.group(1)
print("[+] godzilla key:", key.decode())

# ---- 2. flag.zip with key ----
zips = [p for p in Path(".").rglob("*.zip") if p.name != Path(pcap).name]
flagblob = None
for z in zips:
    sh("7z", "x", f"-p{key.decode()}", f"-o{work / 'fz'}", str(z))
    for f in sorted((work / "fz").rglob("*")):
        if f.is_file() and f.read_bytes()[:4] != b"PK\x03\x04":
            flagblob = f
            break
    if flagblob:
        break
assert flagblob, "flag blob not found in any zip"
print("[+] encrypted flag blob:", flagblob.name, flagblob.stat().st_size, "bytes")

# ---- 3. scan streams: responses -> hex-of-zip; requests -> cat X.txt names ----
nstream = int(sh("tshark", "-r", pcap, "-Y", "tcp", "-T", "fields", "-e", "tcp.stream",
                 text=True).stdout.split()[-1]) + 1
pemzip = None
pwnames = []
for s in range(nstream):
    r = sh("tshark", "-r", pcap, "-Y", f"tcp.stream=={s} && tcp.len>0",
           "-T", "fields", "-e", "tcp.srcport", "-e", "tcp.payload", text=True)
    if not r.stdout.strip():
        continue
    sides: dict[str, bytes] = {}
    for ln in r.stdout.splitlines():
        parts = ln.split("\t")
        if len(parts) == 2 and parts[1]:
            sides[parts[0]] = sides.get(parts[0], b"") + bytes.fromhex(parts[1].replace(":", ""))
    cli = next((v for v in sides.values() if b"POST " in v[:64]), b"")
    srv = next((v for v in sides.values() if v.startswith(b"HTTP/")), b"")
    # requests: DASCTF= payloads
    for mm in re.finditer(rb"DASCTF=([A-Za-z0-9+/=%]+)", cli):
        try:
            enc = urllib.parse.unquote(mm.group(1).decode()).encode()
            b64 = base64.b64decode(enc + b"=" * 16)
            dec = gunzip_tolerant(xkey(b64, key))
        except Exception:
            continue
        if dec:
            for cm in re.finditer(rb"cat (\S+\.txt)", dec):
                name = cm.group(1).decode()
                if name not in pwnames:
                    pwnames.append(name)
    # responses: HTTP 200 bodies (godzilla: hex16 + b64 + xor + gzip)
    for body in re.findall(rb"HTTP/1\.[01] 200.*?\r?\n\r?\n(.*?)(?=HTTP/|\Z)", srv, re.S):
        body = body.strip()
        wm = re.match(rb"[0-9a-f]{16}([A-Za-z0-9+/=]+)", body)
        if not wm:
            continue
        mid = wm.group(1)
        try:
            dec = gunzip_tolerant(xkey(base64.b64decode(mid + b"=" * (-len(mid) % 4)), key))
        except Exception:
            continue
        if not dec:
            continue
        txt = dec.strip()
        if txt.startswith(b"504B") and len(txt) % 2 == 0:
            try:
                pemzip = bytes.fromhex(txt.decode())
            except ValueError:
                continue
            print(f"[+] stream {s}: hex zip of 1.pem ({len(pemzip)} bytes)")
    if pemzip:
        break
assert pemzip, "1.pem zip not found in godzilla responses"
assert pwnames, "no 'cat X.txt' command found"

zp = work / "pem.zip"
zp.write_bytes(pemzip)

# ---- 4. open 1.pem with the txt-name password ----
pempath = None
for name in pwnames:
    for pw in (name[:-4] if name.endswith(".txt") else name, name):
        out = work / "pem"
        sh("rm", "-rf", str(out))
        sh("7z", "x", f"-p{pw}", f"-o{out}", str(zp))
        cands = list(out.rglob("*.pem"))
        if cands:
            pempath = cands[0]
            print("[+] pem zip password:", pw)
            break
    if pempath:
        break
assert pempath, f"1.pem password not among {pwnames}"

# ---- 5. decrypt ----
r = sh("openssl", "pkeyutl", "-decrypt", "-in", str(flagblob), "-inkey", str(pempath))
assert r.returncode == 0, r.stderr.decode(errors="replace")
print("[+] FLAG :", r.stdout.decode().strip())
