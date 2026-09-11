# REAL-17：PostgreSQL 18.4（初赛 REAL-17 · REAL · 700 分 · 初赛全场 0 解）

附件指纹：`07_postgresql_18.4-source.zip`（sha256 前 12 位 `7f88314a09f7`）。
**REAL 类答案未经任何提交验证**（初赛 0 解、无题面描述、无实例）：最可能的答案形态是
与该精确版本绑定的 **CVE 编号**。18.4=安全发布版（修 11 个）。单答案歧义大：优先 6473（批内最高危
CVSS 8.8，2026-09-12 按 postgresql.org/support/security 官方 CVSS 重排），被拒试 6479（唯一预认证）。

## 现场流程

1. 核对附件 sha256 命中本条后，按候选表从上到下提交；每题 **50 次提交上限**，严禁喷候选。
2. 提交形态顺序（每个候选只试两种形态，再拒就换下一个候选）：
   `CVE-YYYY-NNNNN` → `DASCTF{CVE-YYYY-NNNNN}`。
3. 全部候选耗尽仍失败 → 升级调度者记录（REAL 类预算 3-5 次提交为宜，别恋战）。

## 候选 CVE（按置信度）

| 序 | 候选 | 方向 | 依据 |
|---|---|---|---|
| 1 | `CVE-2026-6473` | fixed-in | 批内最高危 CVSS 8.8（postgresql.org/support/security 官方标注）：core server 整数回绕→分配不足→越界写，官方 release notes 明言很可能任意代码执行、批内覆盖 4 处修复点 |
| 2 | `CVE-2026-6479` | fixed-in | CVSS 7.5、批内唯一预认证（PR:N）：SSL/GSS 加密请求交替触发无界递归 DoS；官方 release notes 首条 |
| 3 | `CVE-2026-6475` | fixed-in | CVSS 8.8：pg_basebackup/pg_rewind 路径穿越覆盖任意文件（client 侧工具） |
| 4 | `CVE-2026-6477` | fixed-in | CVSS 8.8：恶意服务端经 libpq lo_* 覆盖客户端栈内存（client 侧） |
| 5 | `（批内其余 7 个，按 CVSS 降序）` | fixed-in | 6637（8.8，contrib/spi 栈溢出+SQLi，示例模块）→ 6476（7.2，pg_createsubscriber SQLi）→ 6478（6.5，MD5 口令时序信道）→ 6472（5.4，multirange 建型权限，原首列）→ 6474（4.3，时区串内存泄露）→ 6575（4.3，仅 18 线）→ 6638（3.7） |

方向说明：fixed-in = 该版本是修复版（答案是它修的 CVE）；affected = 该版本受影响
（答案是打它的 CVE）；adjacent = 邻近版本的安全批（本版既不修也不受影响时的兜底）。

## 决策规则

- 优先「与本版本精确绑定」（fixed-in / affected）的候选；
- 同版本修复多个 CVE 时：选官方公告首列；被拒换批内最高危；
- 两方向都不匹配（nginx 1.31.4 这类）→ 可能考决赛窗口内的新披露，靠调度者现场判断。

## 决赛实测备忘

- 决赛若复用初赛原题（附件 sha256 不变），本表即全部已知信息；若换包（sha256 变），
  以新版本号重查：产品 + 精确版本 → 上一版/下一版的安全公告。
