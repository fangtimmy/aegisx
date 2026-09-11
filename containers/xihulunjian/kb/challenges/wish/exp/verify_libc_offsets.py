# wish — KB 验证脚本 (2026-09-11, aegisx/solver:full + 附件 libc + 配套 ld-2.27.so)
# 来源: KB 整理时新写; 验证结论已写入 SOLVE.md「已确认事实」
# 状态: 可跑 —— 运行方式见 docker 命令于 SOLVE.md 末尾

#!/usr/bin/env python3
"""KB verification: confirm libc offsets used by transcripts against bundled libc.so.6."""
import subprocess
out = subprocess.run(['readelf', '-sW', '/w/libc.so.6'], capture_output=True, text=True).stdout
want = ['system', '__free_hook', '__malloc_hook', '_IO_2_1_stdout_', '_IO_list_all',
        '__libc_start_main', 'setcontext', 'global_max_fast']
for l in out.splitlines():
    if any(w in l for w in want) and ('FUNC' in l or 'OBJECT' in l):
        parts = l.split()
        if len(parts) > 7:
            print(parts[7], hex(int(parts[1], 16)))
print('--- /bin/sh ---')
s = subprocess.run(['strings', '-tx', '/w/libc.so.6'], capture_output=True, text=True).stdout
for l in s.splitlines():
    if '/bin/sh' in l:
        print('bin_sh', '0x' + l.split()[0])
