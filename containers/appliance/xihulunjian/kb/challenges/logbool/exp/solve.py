#!/usr/bin/env python3
"""logbool (MISC-02) — rebuild blind-SQLi-exfiltrated strings from logbool.pcapng.

Oracle: each sqlmap probe `?id=1' AND ORD(MID((SELECT ...),pos,1))>N AND 'x'='x`
is forwarded by the PHP app to MySQL (127.0.0.1:3306) as
`SELECT * FROM ctfuser WHERE id='...' LIMIT 0,1`. The MySQL result set in the
pcap carries a row (1,zhangsan,zhang) iff the condition was TRUE. Solving all
per-position comparison constraints rebuilds ctftest.ctfblob row 1:
id=1, username=boolblob, password=timeemitloggol, content=hex of a RAR5
(password = the password column) containing flag.txt.

Deps: tshark (wireshark), unrar or 7z. Fallback oracle: HTTP objects whose
body contains "success" (TRUE). Usage: python3 solve.py [logbool.pcapng] —
without args it finds the pcapng under the current directory.
"""
import re
import shutil
import subprocess
import sys
import urllib.parse
from collections import defaultdict
from pathlib import Path

PAT = re.compile(
    r"ORD\(MID\(\(SELECT IFNULL\(CAST\((?P<col>[^)]*?)(?: AS NCHAR)?\),0x20\) "
    r"FROM ctftest\.ctfblob(?: ORDER BY id LIMIT (?P<off>\d+),\d+)?\),"
    r"(?P<pos>\d+),\d+\)\)(?P<op>>=|>|!=|=)(?P<num>\d+)"
)


def find_pcap() -> Path:
    if len(sys.argv) > 1:
        pcap = Path(sys.argv[1])
    else:
        cands = sorted(Path().rglob("logbool.pcapng")) or sorted(Path().rglob("*.pcapng"))
        if not cands:
            sys.exit("[-] no pcapng under cwd — unzip logbool的附件.zip first")
        pcap = cands[0]
    if not pcap.exists():
        sys.exit(f"[-] {pcap} not found")
    return pcap


def add_probe(probes: dict, payload: str, truth: bool) -> bool:
    m = re.search(r"id='(.*)' LIMIT 0,1$", payload)
    if m:
        m2 = PAT.search(m.group(1))
    else:
        m2 = PAT.search(payload)  # HTTP fallback: probe is the raw decoded URI
    if not m2:
        return False
    key = (m2.group("col").strip(), int(m2.group("off") or 0), int(m2.group("pos")))
    probes[key].append((m2.group("op"), int(m2.group("num")), truth))
    return True


def mysql_probes(pcap: Path):
    """Pair every COM_QUERY with its result set: row present == TRUE."""
    cmd = ["tshark", "-r", str(pcap), "-Y", "mysql", "-T", "fields",
           "-e", "frame.number", "-e", "tcp.stream", "-e", "mysql.query", "-e", "mysql.row.text"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    streams = defaultdict(list)
    for line in out.decode("utf-8", "replace").splitlines():
        parts = (line.split("\t") + ["", "", "", ""])[:4]
        streams[parts[1]].append((int(parts[0]), parts[2], parts[3]))

    probes, stats = defaultdict(list), {"paired": 0, "true": 0}
    for evs in streams.values():
        pending = None  # [query, rows_seen, response_started]
        for frame, query, rowtext in sorted(evs):
            if query:
                if pending is not None and pending[0] == query and not pending[2]:
                    continue  # retransmitted COM_QUERY, response not started yet
                if pending is not None and pending[2]:
                    add_probe(probes, pending[0], pending[1])
                    stats["paired"] += 1
                    stats["true"] += pending[1]
                pending = [query, bool(rowtext), False]
            elif pending is not None:
                if rowtext:
                    pending[1] = True
                pending[2] = True
        if pending is not None and pending[2]:
            add_probe(probes, pending[0], pending[1])
            stats["paired"] += 1
            stats["true"] += pending[1]
    return probes, stats


def http_probes(pcap: Path):
    """Fallback oracle: exported HTTP object bodies contain "success" iff TRUE."""
    outdir = Path("httpobj")
    outdir.mkdir(exist_ok=True)
    subprocess.run(["tshark", "-r", str(pcap), "--export-objects", f"http,{outdir}", "-q"],
                   check=True, capture_output=True)
    probes, stats = defaultdict(list), {"paired": 0, "true": 0}
    for f in outdir.iterdir():
        truth = b"success" in f.read_bytes()
        stats["paired"] += 1
        stats["true"] += truth
        add_probe(probes, urllib.parse.unquote(f.name), truth)
    return probes, stats


def build(probes: dict, col: str, off: int = 0) -> str:
    """Left-to-right chars while every position has one printable candidate."""
    by_pos = defaultdict(list)
    for (c, o, pos), cons in probes.items():
        if c == col and o == off:
            by_pos[pos].extend(cons)
    chars = []
    for pos in range(1, max(by_pos, default=0) + 1):
        if pos not in by_pos:
            break
        cands = [v for v in range(256) if all(
            (v > n) == t if op == ">" else
            (v >= n) == t if op == ">=" else
            (v != n) == t if op == "!=" else
            (v == n) == t
            for op, n, t in by_pos[pos])]
        if len(cands) != 1 or not 32 <= cands[0] < 127:
            break  # ambiguous terminator position (sqlmap stops at string end)
        chars.append(chr(cands[0]))
    return "".join(chars)


def extract_rar(rar: Path, pw: str, outdir: Path) -> str:
    if shutil.which("unrar"):  # native RAR, handles RAR5 encryption
        subprocess.run(["unrar", "x", "-y", f"-p{pw}", str(rar), f"{outdir}/"],
                       check=True, capture_output=True)
    elif shutil.which("7z"):
        subprocess.run(["7z", "e", "-y", f"-p{pw}", f"-o{outdir}", str(rar)],
                       check=True, capture_output=True)
    else:
        sys.exit("[-] need unrar or 7z to extract the RAR")
    return (outdir / "flag.txt").read_text().strip()


def main():
    pcap = find_pcap()
    print(f"[+] pcap        : {pcap}")

    try:
        probes, stats = mysql_probes(pcap)
        src = f"MySQL protocol pairing ({stats['paired']} queries, {stats['true']} TRUE)"
    except Exception as e:
        probes, src = {}, f"mysql path failed: {e}"
    if len(probes) < 100:  # dissector trouble -> HTTP oracle
        probes, stats = http_probes(pcap)
        src = f"HTTP objects ({stats['paired']} responses, {stats['true']} TRUE)"
    print(f"[+] oracle      : {src}")
    n = sum(len(v) for v in probes.values())
    print(f"[+] probes      : {n} comparisons over {len(probes)} (column, offset, position) keys")

    cols = {col: build(probes, col) for col in ("id", "username", "password", "content")}
    print(f"[+] id          : {cols['id']}")
    print(f"[+] username    : {cols['username']}")
    print(f"[+] password    : {cols['password']}")
    h = cols["content"]
    print(f"[+] content     : {len(h)} hex chars, {h[:64]}...")

    rar = bytes.fromhex(h)
    if rar[:8] != b"Rar!\x1a\x07\x01\x00":
        sys.exit(f"[-] content is not a RAR5 archive: {rar[:16].hex()}")
    Path("content.rar").write_bytes(rar)
    print(f"[+] content.rar : {len(rar)} bytes (RAR5, password-protected flag.txt)")

    flag = extract_rar(Path("content.rar"), cols["password"], Path("extracted"))
    print(f"[+] flag.txt    : {flag}")
    m = re.search(r"\{(.+)\}", flag)
    print(f"[+] FLAG        : {m.group(1) if m else flag}")


if __name__ == "__main__":
    main()
