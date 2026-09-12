# sm4rev（初赛 REVERSE-06 · Reverse · 200 分）

makeself 自解压壳的 SM4 校验器：静态 stripped ELF 逐块加密输入并与固定密文比较。
**flag 由固定密钥与密文唯一决定，无需分析二进制**——exp 已内置两者，直接运行即得。

## 快速路径（约 1 秒，纯标准库）

```bash
python3 /opt/solver/knowledges/xihulunjian/challenges/sm4rev/exp/solve.py
```

预期输出：

```
[+] FLAG : DASCTF{SM4_is_secure_but_d0nt_t3ll_any0ne!}
```

提交值（花括号内裸值）：`SM4_is_secure_but_d0nt_t3ll_any0ne!`
若裸值被拒，用完整形态 `DASCTF{SM4_is_secure_but_d0nt_t3ll_any0ne!}` 重试一次，再拒升级调度者。

## 原理（备查）

- 附件前 48 行是 makeself 解压脚本，第 49 行起 gzip 压缩真实 ELF：
  `tail -n +49 sm4rev | gzip -cd > sm4_rev.bin`；
- 验证逻辑 = SM4-ECB：密钥 `0123456789abcdeffedcba9876543210`（标准示例密钥），
  期望密文 48 字节 = `825dad7d…2437 35bf`（3 分组，exp 内置）；
- 解密 = 轮密钥逆序再走加密结构；尾部 `\x05*5` 为 PKCS#7 填充。

## 失败分支

- exp 无外部依赖，正常不会失败。若决赛重新生成密钥（附件 sha256 变），按上面原理
  重新提取：`main` 在提示串 `"please input flag: "` 交叉引用处，密钥/密文在验证函数
  栈初始化数据里（见 exp 内注释的提取锚点）。

## 决赛实测备忘

- 初赛 60 队解出；决赛测试赛未出现此题。flag 初赛提交实证：`SM4_is_secure_but_d0nt_t3ll_any0ne!`。
