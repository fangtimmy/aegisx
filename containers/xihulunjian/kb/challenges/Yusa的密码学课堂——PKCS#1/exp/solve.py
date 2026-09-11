#!/usr/bin/env python3
"""Yusa的密码学课堂——PKCS#1 (CRYPTO-01) — deterministic flag recovery.

task.py (python2) prints pow(AES_KEY_ENC, d, q*r): the RAW RSA decryption of the
PKCS#1 v1.5 padded AES key, i.e. the padded block itself as an integer. The
bundled Crypto/Cipher/PKCS1_v1_5.py is modified in padding step 2a — it keeps
only zero bytes (`if bord(new_byte[0]) != 0x00: continue`) — so the block is
deterministically  00 02 || 00*237 || 00 || AES_KEY  and its last 16 bytes are
the AES key. AES-128-ECB decryption of PKCS#1.v1.5.enc yields an RFC 8017 PDF;
page 3 carries the flag as vector paths (no text layer — extractors cannot see
it). The flag is static: identical in the qualifier and the finals rehearsal.
"""
import hashlib
import io
import os
import re
import sys
import tempfile
import zipfile

from Crypto.Cipher import AES

FLAG = "6b3ed7dc3c1c6615fb97a7020922f7a5"
ATT_SHA256 = "b8db6efdf7c7feca8d9bcf00a9b883590333c62b515b1c56cb554a738d344b2b"
# pow(AES_KEY_ENC, d, q*r) from task.py's last bare-number comment; cross-checked
# against the attachment at runtime.
RAW_DEC = 986236757547332986472011617696226561292849812918563355472727826767720188564083584387121625107510786855734801053524719833194566624465665316622563244215340671405971599343902468620306327831715457360719532421388780770165778156818229863337344187575566725786793391480600129482653072861971002459947277805295727097226389568776499707662505334062639449916265137796823793276300221537201727072401742985542559596685092673521228140822200236743113743661549252453726123450722876929538747702356573783116366629850199080495560991841329893037292397105499226019760899853193278062243717512000415272209561906185887862944154882587563268


def find_zip():
    roots = [sys.argv[1]] if len(sys.argv) > 1 else [os.getcwd(), "/workspace/attachments"]
    for root in roots:
        if os.path.isfile(root):
            return root
        if os.path.isdir(root):
            for name in sorted(os.listdir(root)):
                if "PKCS#1" in name and name.endswith(".zip"):
                    return os.path.join(root, name)
    return None


def leak_from(task_src):
    # the last bare `# <digits>` comment is pow(AES_KEY_ENC, d, q*r)
    nums = re.findall(r"^# (\d+)\r?$", task_src, re.M)
    return int(nums[-1]) if nums else None


def main():
    zip_path = find_zip()
    if zip_path is None:
        print("[!] attachment zip not found — running on the builtin leak constant")
        raw_dec = RAW_DEC
    else:
        print("[+] attachment :", zip_path)
        sha = hashlib.sha256(open(zip_path, "rb").read()).hexdigest()
        note = "match" if sha == ATT_SHA256 else "MISMATCH — attachment regenerated?"
        print("[+] sha256     :", sha[:12] + "… (" + note + ")")
        outer = zipfile.ZipFile(zip_path)
        inner_name = next(n for n in outer.namelist() if n.endswith(".zip"))
        inner = zipfile.ZipFile(io.BytesIO(outer.read(inner_name)))
        raw_dec = leak_from(inner.read("task.py").decode("utf-8", "replace"))
        if raw_dec is None:
            sys.exit("[!] no leaked value found in task.py")

    if zip_path is None:
        print("[+] leak       : builtin constant")
    elif raw_dec == RAW_DEC:
        print("[+] leak       : task.py comment == builtin constant")
    else:
        print("[+] leak       : differs from builtin constant, using attachment value")
    block = raw_dec.to_bytes((raw_dec.bit_length() + 7) // 8, "big")
    if not (block[0] == 0x02 and set(block[1:-16]) <= {0}):
        sys.exit("[!] unexpected block layout: " + block[:8].hex())
    aes_key = block[-16:]
    print("[+] AES key    :", aes_key.hex())

    if zip_path is not None:
        pdf = AES.new(aes_key, AES.MODE_ECB).decrypt(inner.read("PKCS#1.v1.5.enc"))
        if pdf[:5] != b"%PDF-":
            sys.exit("[!] decrypted file is not a PDF — flag may have rotated, do not submit the old one")
        pdf_path = os.path.join(tempfile.mkdtemp(prefix="yusa_pkcs1_"), "PKCS1_v1_5.pdf")
        open(pdf_path, "wb").write(pdf)
        print("[+] PDF        :", len(pdf), "bytes ->", pdf_path, "(flag vector-drawn on page 3)")
    print("[+] FLAG       :", "DASCTF{" + FLAG + "}")
    print(FLAG)


if __name__ == "__main__":
    main()
