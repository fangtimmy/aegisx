# REAL-12：Apache httpd 2.4.68（初赛 REAL-12 · REAL · 700 分 · 初赛全场 0 解）

附件指纹：`02_httpd_2.4.68-source.zip`（sha256 前 12 位 `2d582d3549f2`）。
**REAL 类答案未经任何提交验证**（初赛 0 解、无题面描述、无实例）：最可能的答案形态是
与该精确版本绑定的 **CVE 编号**。2026-09-12 加深研究修正旧判：官方 vulnerabilities_24 页确认
2.4.68（2026-06-08 发布）本身就是安全版，修复 13 个 CVE（2.4.69/2.4.70 不存在）——方向转为 **fixed-in**，批内 13 选 1。

## 现场流程

1. 核对附件 sha256 命中本条后，按候选表从上到下提交；每题 **50 次提交上限**，严禁喷候选。
2. 提交形态顺序（每个候选只试两种形态，再拒就换下一个候选）：
   `CVE-YYYY-NNNNN` → `DASCTF{CVE-YYYY-NNNNN}`。
3. 全部候选耗尽仍失败 → 升级调度者记录（REAL 类预算 3-5 次提交为宜，别恋战）。

## 候选 CVE（按置信度）

| 序 | 候选 | 方向 | 依据 |
|---|---|---|---|
| 1 | `CVE-2026-44119` | fixed-in | 官方 vulnerabilities_24 页标注 moderate：.htaccess 表达式提权（本地 .htaccess 作者可读 httpd 权限文件）——批内唯一提权类、CTF 考点价值最高；2026-09-12 按官方 severity 重排（批内 6 moderate + 7 low，无 important/critical，原首列 29167 仅 low） |
| 2 | `CVE-2026-34355` | fixed-in | 官方标注 moderate：mod_proxy_html 缓冲区溢出（不可信后端注入）——批内最「二进制」考点 |
| 3 | `CVE-2026-42535` | fixed-in | 官方标注 moderate：mod_dav_fs 保护目录访问绕过（DAV 属性库路径处理） |
| 4 | `CVE-2026-29167` | fixed-in | 官方页 2.4.68 段首列（low，mod_ldap 每目录 UAF）——出题人机械取首列时的答案；severity 信号弱故列第 4 |
| 5 | `CVE-2026-49975` | fixed-in | 官方标注 moderate：mod_http2 文件句柄耗尽时超大内存分配 DoS |
| 6 | `（批内其余 8 个）` | fixed-in | moderates：43951（mod_headers OOB 读）→ 44186（proxy_ftp 死循环）；lows：29170（proxy_ftp XSS）→ 34356（CookieMap 堆溢出）→ 42536（xml2enc 堆溢出）→ 44185（OCSP 栈越界读）→ 44631（ap_regname 堆下溢）→ 48913（http2 UAF） |
| 7 | `CVE-2026-34059` / `CVE-2026-23918` | adjacent | 2.4.67 批兜底（mod_proxy_ajp 越界读 / HTTP/2 double-free RCE），13 批耗尽后再试 |

方向说明：fixed-in = 该版本是修复版（答案是它修的 CVE）；affected = 该版本受影响
（答案是打它的 CVE）；adjacent = 邻近版本的安全批（本版既不修也不受影响时的兜底）。

## 决策规则

- 优先「与本版本精确绑定」（fixed-in / affected）的候选；
- 同版本修复多个 CVE 时：选官方公告首列；被拒换批内最高危；
- 两方向都不匹配（nginx 1.31.4 这类）→ 可能考决赛窗口内的新披露，靠调度者现场判断。

## 决赛实测备忘

- 决赛若复用初赛原题（附件 sha256 不变），本表即全部已知信息；若换包（sha256 变），
  以新版本号重查：产品 + 精确版本 → 上一版/下一版的安全公告。
