#!/usr/bin/env python3
"""特殊流量2 (MISC-06, 2024 楚慧杯原题) — deterministic flag recovery from the attachment.

Chain (all data extracted live from the pcapng, nothing hardcoded):
  zip -> traffic2.pcapng -> GET /www.zip -> my_rsa.php (RSA-1024 public key)
  -> 16 AntSword POSTs to /uploads/my_rsa.php; the webshell runs
     openssl_public_decrypt on every POST param, so traffic is decodable as
     m = c^e mod n (PKCS#1 v1.5 type-1: 00 01 FF..FF 00 <msg>)
  -> commands reveal: sed 's/[i7]/x/g' secret, md5sum secret,
     echo "U2FsdGVkX1..." > flag.txt
  -> responses reveal: masked secret xx34d619x1brxgd9mgd4xzxwxytv669w and
     its md5 (computed over content WITH trailing newline)
  -> brute-force x->{i,7,x} against the md5 -> secret = AES password
  -> openssl Salted__ / EVP_BytesToKey(MD5) AES-256-CBC -> NATO alphabet text
  -> DASCTF + <UUID>; the platform flag is the lowercase bare UUID.

Deps: tshark (stream reassembly), pycryptodome (AES). Everything else stdlib.
Usage: run with the challenge directory as cwd (attachment zip in cwd):
  python3 /path/to/solve.py [path-to-zip-or-dir]
"""
import base64
import glob
import hashlib
import itertools
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile

from Crypto.Cipher import AES

NATO = {
    "Alpha": "A", "Bravo": "B", "Charlie": "C", "Delta": "D", "Echo": "E",
    "Foxtrot": "F", "Golf": "G", "Hotel": "H", "India": "I", "Juliett": "J",
    "Kilo": "K", "Lima": "L", "Mike": "M", "November": "N", "Oscar": "O",
    "Papa": "P", "Quebec": "Q", "Romeo": "R", "Sierra": "S", "Tango": "T",
    "Uniform": "U", "Victor": "V", "Whiskey": "W", "X-ray": "X", "Yankee": "Y",
    "Zulu": "Z", "One": "1", "Two": "2", "Three": "3", "Four": "4",
    "Five": "5", "Six": "6", "Seven": "7", "Eight": "8", "Nine": "9",
    "Zero": "0", "Dash": "-",
}


def find_zip(root: str) -> str:
    if root.endswith(".zip"):
        return root
    for p in sorted(glob.glob(os.path.join(root, "*.zip"))):
        try:
            with zipfile.ZipFile(p) as z:
                if any(n.endswith(".pcapng") for n in z.namelist()):
                    return p
        except zipfile.BadZipFile:
            continue
    raise SystemExit("[-] no attachment zip containing a .pcapng found")


def tshark(*args: str) -> str:
    return subprocess.run(["tshark", *args], capture_output=True,
                          text=True, check=True).stdout


def follow_stream(pcap: str, sid: str) -> tuple[bytes, bytes]:
    """Return (client->server bytes, server->client bytes) of one TCP stream."""
    out = tshark("-r", pcap, "-q", "-z", f"follow,tcp,raw,{sid}")
    client, server, started = b"", b"", False
    for line in out.splitlines():
        if line.startswith("Node 1:"):
            started = True
            continue
        if not started or line.startswith("===="):
            continue
        if not line.strip():
            continue
        data = bytes.fromhex(line.strip())
        if line.startswith("\t"):
            server += data
        else:
            client += data
    return client, server


def http_body(raw: bytes) -> bytes:
    return raw.partition(b"\r\n\r\n")[2]


def parse_rsa_pub(pem: str) -> tuple[int, int]:
    b64 = "".join(re.search(
        r"-----BEGIN PUBLIC KEY-----(.*?)-----END PUBLIC KEY-----",
        pem, re.S).group(1).split())
    der = base64.b64decode(b64)

    def tlv(buf: bytes, off: int) -> tuple[bytes, int]:
        ln = buf[off + 1]
        off += 2
        if ln & 0x80:
            nb = ln & 0x7F
            ln = int.from_bytes(buf[off:off + nb])
            off += nb
        return buf[off:off + ln], off + ln

    spki, _ = tlv(der, 0)          # SubjectPublicKeyInfo content
    _, off = tlv(spki, 0)          # skip AlgorithmIdentifier SEQ
    bits, _ = tlv(spki, off)       # BIT STRING
    rsapub, _ = tlv(bits[1:], 0)   # RSAPublicKey SEQ content (skip unused bits)
    n_der, off = tlv(rsapub, 0)
    e_der, _ = tlv(rsapub, off)
    return int.from_bytes(n_der, "big"), int.from_bytes(e_der, "big")


def b64pad(s: str) -> str:
    return s + "=" * (-len(s) % 4)


def decode_response(body: str) -> str | None:
    """AntSword response = <rand prefix><base64><rand suffix>; the random
    prefix/suffix are hex and merge into the base64 run, so try every
    prefix offset and keep the printable decode (junk tail is harmless)."""
    run = re.search(r"[A-Za-z0-9+/=]+", body)
    if not run:
        return None
    for off in range(17):
        s = run.group(0)[off:]
        if len(s) < 8:
            break
        s = s.split("=")[0]
        try:
            text = base64.b64decode(b64pad(s)).decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            continue
        if sum(c.isprintable() or c in "\r\n" for c in text) / len(text) > 0.9:
            return text
    return None


def main() -> None:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    zip_path = find_zip(root)
    print(f"[+] attachment : {os.path.basename(zip_path)}")

    with tempfile.TemporaryDirectory() as td, zipfile.ZipFile(zip_path) as z:
        member = next(n for n in z.namelist() if n.endswith(".pcapng"))
        pcap = os.path.join(td, "traffic.pcapng")
        with open(pcap, "wb") as f:
            f.write(z.read(member))

        # --- locate streams: www.zip response + all webshell POSTs ---
        www_streams = tshark(
            "-r", pcap, "-Y", 'http.request.uri contains "www.zip"',
            "-T", "fields", "-e", "tcp.stream").split()
        post_streams = tshark(
            "-r", pcap, "-Y", 'http.request.method == "POST"',
            "-T", "fields", "-e", "tcp.stream").split()
        print(f"[+] streams    : www.zip={www_streams} posts={len(post_streams)}")

        # --- www.zip -> my_rsa.php -> (n, e) ---
        n = e = None
        for sid in www_streams:
            _, srv = follow_stream(pcap, sid)
            body = http_body(srv)
            if not body.startswith(b"PK"):
                continue
            www_path = os.path.join(td, "www.zip")
            with open(www_path, "wb") as f:
                f.write(body)
            zipfile.ZipFile(www_path).extractall(td)
            php = open(os.path.join(td, "my_rsa.php")).read()
            n, e = parse_rsa_pub(php)
            break
        assert n, "www.zip / my_rsa.php not found in traffic"
        print(f"[+] rsa pub    : {n.bit_length()}-bit, e={e}")

        def pub_dec(block: bytes) -> bytes:
            m = pow(int.from_bytes(block, "big"), e, n).to_bytes(128, "big")
            if m[:2] == b"\x00\x01" and b"\x00" in m[2:]:  # PKCS#1 v1.5 sig
                return m.split(b"\x00", 2)[2]
            return m

        def decode_param(v: str) -> bytes:
            frags = []
            for piece in urllib.parse.unquote(v).split("|"):
                raw = base64.b64decode(piece)
                assert len(raw) % 128 == 0
                for i in range(0, len(raw), 128):
                    frags.append(pub_dec(raw[i:i + 128]))
            return b"".join(frags)

        commands, responses = [], []
        for sid in post_streams:
            cli, srv = follow_stream(pcap, sid)
            try:
                parts = []
                for pair in http_body(cli).decode("latin1").split("&"):
                    k, _, v = pair.partition("=")
                    if k != "ant":  # ant = webshell template, rest = payload
                        parts.append(decode_param(v)[2:])  # strip 2 rand chars
                cmd = b"".join(
                    base64.b64decode(b64pad(p.decode("latin1"))) for p in parts)
                commands.append(cmd.decode("utf-8", "replace"))
            except Exception:
                pass
            body = http_body(srv).decode("latin1")
            dec = decode_response(body)
            if dec:
                responses.append(dec)

    all_cmds = "\n".join(commands)
    all_resps = "\n".join(responses)

    # --- masked secret + md5 from `sed` / `md5sum` responses ---
    masked = None
    for line in all_resps.splitlines():
        if re.fullmatch(r"[0-9a-z]{30,40}", line) and line.count("x") >= 3:
            masked = line
            break
    md5m = re.search(r"([0-9a-f]{32})\s+secret", all_resps)
    assert masked, "masked secret line not found in responses"
    print(f"[+] masked     : {masked}")
    md5_target = md5m.group(1)
    print(f"[+] md5sum     : {md5_target}  (over content WITH trailing \\n)")

    # --- flag.txt ciphertext from the `echo U2FsdGVkX1... > flag.txt` cmd ---
    ctm = re.search(r"U2FsdGVkX1[A-Za-z0-9+/=]+", all_cmds)
    assert ctm, "flag.txt ciphertext not found in commands"
    print(f"[+] flag.txt   : openssl Salted__ AES blob, {len(ctm.group(0))} b64 chars")

    # --- brute-force x -> {i,7,x} against the md5 (newline included) ---
    pos = [i for i, c in enumerate(masked) if c == "x"]
    secret = None
    for combo in itertools.product("i7x", repeat=len(pos)):
        cand = list(masked)
        for p, ch in zip(pos, combo):
            cand[p] = ch
        if hashlib.md5(("".join(cand) + "\n").encode()).hexdigest() == md5_target:
            secret = "".join(cand)
            break
    assert secret, "brute force against md5 failed"
    print(f"[+] secret     : {secret}")

    # --- openssl EVP_BytesToKey(MD5) + AES-256-CBC decrypt ---
    blob = base64.b64decode(ctm.group(0))
    assert blob[:8] == b"Salted__"
    salt, ct = blob[8:16], blob[16:]
    d, prev = b"", b""
    while len(d) < 48:
        prev = hashlib.md5(prev + secret.encode() + salt).digest()
        d += prev
    key, iv = d[:32], d[32:48]
    pt = AES.new(key, AES.MODE_CBC, iv).decrypt(ct)
    pt = pt[:-pt[-1]]  # strip PKCS#7 padding
    print(f"[+] NATO       : {pt.decode()}")

    # --- NATO -> DASCTF + UUID; platform flag = lowercase bare UUID ---
    words = pt.decode().split()
    s = "".join(NATO[w] for w in words)
    assert s.startswith("DASCTF"), s
    flag = s[len("DASCTF"):].lower()
    assert re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", flag), flag
    print(f"[+] FLAG       : {flag}")
    print(f"[+] full form  : DASCTF{{{flag}}}")
    print(f"[+] quali md5  : {md5_target}  (初赛平台注册值, 决赛不应再提交)")


if __name__ == "__main__":
    main()
