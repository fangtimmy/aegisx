#!/bin/bash
# PixMatrix (MISC-08) — invert the 2x2 block transpose (swap TR<->BL quadrants),
# upscale the pixel font, OCR with tesseract. Run inside the unpacked directory
# (needs PixMatrix.jpg; find it recursively if nested).
set -e
JPG=$(find . -name 'PixMatrix.jpg' | head -1)
[ -n "$JPG" ] || { echo "PixMatrix.jpg not found — unzip the attachment (nested zip, inner uses xz; use 7z)"; exit 1; }
cd "$(dirname "$JPG")"
python3 - <<'PY'
from PIL import Image
im = Image.open("PixMatrix.jpg").convert("RGB")
w, h = im.size
out = Image.new("RGB", (w, h))
out.paste(im.crop((0, 0, w // 2, h // 2)), (0, 0))
out.paste(im.crop((0, h // 2, w // 2, h)), (w // 2, 0))
out.paste(im.crop((w // 2, 0, w, h // 2)), (0, h // 2))
out.paste(im.crop((w // 2, h // 2, w, h)), (w // 2, h // 2))
out.save("flag_recovered.png")
g = out.convert("L").point(lambda p: 0 if p < 128 else 255)
g = g.resize((g.width * 12, g.height * 12), Image.NEAREST)
g.save("flag_big.png")
print("[+] recovered -> flag_recovered.png / flag_big.png")
PY
tesseract flag_big.png stdout --psm 6 2>/dev/null | head -5
echo "[+] known flag (quali accepted): 824f1e986260efa86f1bd252b5e13a4d"
