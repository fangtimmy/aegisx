# Solver

Three tiers share one Dockerfile; every tier ships offline-ready with the agent SDK and `ENVIRONMENT.md`. Pick via the `container.image` setting (default `aegisx/solver:full`). Run from the repo root:

```shell
docker buildx build -f containers/solver/Dockerfile --target minimal   -t aegisx/solver:minimal   .
docker buildx build -f containers/solver/Dockerfile --target essential -t aegisx/solver:essential .
docker buildx build -f containers/solver/Dockerfile --target full      -t aegisx/solver:full      .
```

Build ascending (minimal → essential → full): the tiers are stacked stages sharing apt/pip/git/download cache mounts, so later tiers reuse earlier layers and nothing re-downloads. `--target` skips sibling stages — building essential never builds minimal's tail and vice versa.

## Tiers

| Tier | Size | Contents |
|---|---|---|
| `minimal` | 0.85 GB | Base Kali + CLI/network essentials, bare gdb, Python venv (pwntools, requests, pycryptodome, gmpy2, sympy, z3, capstone, ropper, scapy). No knowledge bases, wordlists, compilers, or CTF tool breadth — missing tools go through the in-image 缺工具 SOP. |
| `essential` | 4.75 GB | Full CTF-category coverage: curated kali packages (nmap, sqlmap, ffuf, nuclei, seclists trimmed to Discovery/Payloads + rockyou, binwalk, steghide, sleuthkit, john, rizin, qemu-user, smbclient, tesseract, PHP, ruby/zsteg/one_gadget), GitHub release binaries (katana/naabu/dalfox/fscan/dddd/bkcrack/pwninit/kerbrute/cloudfox/wsrx), pycdc, knowledge bases (PayloadsAllTheThings, InternalAllTheThings, hacktricks, libc-database), extended venv (impacket, mitmproxy, fpylll, eth-account, …). |
| `full` | 16.7 GB | essential + kali-linux-headless suite (netexec, evil-winrm, responder, hashcat, …), full seclists (Passwords/Miscellaneous/Usernames restored, Fuzzing still pruned), pwndbg, ghidra, jadx/apktool, llvm, wine, playwright+chromium, tshark, ffmpeg, JDK+ysoserial, golang, memory forensics (volatility3+dwarf2json), AD suite (bloodyAD/certipy/coercer/pypykatz), angr/scipy/opencv, vulhub + hacktricks-cloud. |

`ENVIRONMENT.md` is generated inside each image at build time by probing that image's actual filesystem (`which`, paths, `pip freeze`) — it never mentions tiers and always matches what the image contains; edit `gen-environment.py` to change it. `/opt/solver/VARIANT` stamps the tier for tooling.
