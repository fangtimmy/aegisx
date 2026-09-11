#!/usr/bin/env python3
"""bouquet (REVERSE-09, PE32 MSVC) — deterministic flag recovery.

The binary builds a complete binary tree from the 25-char input via level-order
insertion, then checks the inorder and postorder traversals against two
embedded strings. The input IS the level-order sequence, so reconstruct the
tree from inorder+postorder and read it level-order.
"""
from collections import deque

INORDER = "ja7Cws_A3daTd4qDo8}F_Sd{a"
POSTORDER = "j7aw_sC3addq4TAo}8_Fda{SD"
assert len(INORDER) == len(POSTORDER) == 25


def build(ino: str, post: str):
    if not ino:
        return None
    root = post[-1]
    k = ino.index(root)
    return (root, build(ino[:k], post[:k]), build(ino[k + 1:], post[k:-1]))


tree = build(INORDER, POSTORDER)
q = deque([tree])
level = []
while q:
    node = q.popleft()
    level.append(node[0])
    if node[1]:
        q.append(node[1])
    if node[2]:
        q.append(node[2])
flag = "".join(level)


def tin(t):
    return (tin(t[1]) + t[0] + tin(t[2])) if t else ""


def tpo(t):
    return (tpo(t[1]) + tpo(t[2]) + t[0]) if t else ""


assert tin(tree) == INORDER and tpo(tree) == POSTORDER, "traversal round-trip failed"
print("[+] FLAG :", flag)
print("[+] submit:", flag[7:-1] if flag.startswith("DASCTF{") else flag)
