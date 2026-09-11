# REAL-15：OpenResty 1.31.1.1（初赛 REAL-15 · REAL · 700 分 · 初赛全场 0 解）

附件指纹：`05_openresty_1.31.1.1-source.zip`（sha256 前 12 位 `ab219fed0a4a`）。
**REAL 类答案未经任何提交验证**（初赛 0 解、无题面描述、无实例）：最可能的答案形态是
与该精确版本绑定的 **CVE 编号**。shipped=受影响版方向（nginx 1.31.1）。56434 是主答案
（nginx.org 官方 advisory 批内唯一 major，2026-09-12 核实重排）。

## 现场流程

1. 核对附件 sha256 命中本条后，按候选表从上到下提交；每题 **50 次提交上限**，严禁喷候选。
2. 提交形态顺序（每个候选只试两种形态，再拒就换下一个候选）：
   `CVE-YYYY-NNNNN` → `DASCTF{CVE-YYYY-NNNNN}`。
3. 全部候选耗尽仍失败 → 升级调度者记录（REAL 类预算 3-5 次提交为宜，别恋战）。

## 候选 CVE（按置信度）

| 序 | 候选 | 方向 | 依据 |
|---|---|---|---|
| 1 | `CVE-2026-56434` | affected | nginx.org 官方 advisory 批内唯一 major：HTTP/3 UAF，影响 0.8.11–1.31.2、1.31.3 修复；openresty 1.31.1.1 基座 nginx 1.31.1 在区间内（nginx.org/en/security_advisories.html 直接点名） |
| 2 | `CVE-2026-42530` | affected | nginx.org advisory：proxy_v2/grpc 模块缓冲区溢出（medium），影响恰为 1.31.0–1.31.1、修于 1.31.2——与基座版本「上一上游版即修复」精确绑定 |
| 3 | `CVE-2026-42533` | affected | nginx.org advisory：slice 模块内存泄露（medium），影响 0.9.6–1.31.2，原首候选；区间宽、非版本特异故降位 |
| 4 | `CVE-2026-60005` | affected | nginx.org advisory：SSI 模块 UAF（medium），影响 1.15.8–1.31.2 |

方向说明：fixed-in = 该版本是修复版（答案是它修的 CVE）；affected = 该版本受影响
（答案是打它的 CVE）；adjacent = 邻近版本的安全批（本版既不修也不受影响时的兜底）。

## 决策规则

- 优先「与本版本精确绑定」（fixed-in / affected）的候选；
- 同版本修复多个 CVE 时：选官方公告首列；被拒换批内最高危；
- 两方向都不匹配（nginx 1.31.4 这类）→ 可能考决赛窗口内的新披露，靠调度者现场判断。

## 决赛实测备忘

- 决赛若复用初赛原题（附件 sha256 不变），本表即全部已知信息；若换包（sha256 变），
  以新版本号重查：产品 + 精确版本 → 上一版/下一版的安全公告。
