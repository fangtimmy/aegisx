#!/usr/bin/env python3
"""MirrorShield (REVERSE-02, APK malware analysis) — deterministic flag.

Flag = md5(md5("<behavior>#<C2>#<crew>")). The three values are distilled
from the APK analysis chain (see SOLVE.md); if the APK sha256 changed,
re-derive them there before trusting this.
"""
import hashlib

BEHAVIOR = "CONTACTS_OTP"
C2 = "https://cipher-nest.sc26.invalid:12443/courier/v7/check"
CREW = "MIRROR_PANTHER"

s = f"{BEHAVIOR}#{C2}#{CREW}"
h1 = hashlib.md5(s.encode()).hexdigest()
h2 = hashlib.md5(h1.encode()).hexdigest()
print("[+] inner string :", s)
print("[+] md5 #1       :", h1)
print("[+] FLAG (submit):", h2)
