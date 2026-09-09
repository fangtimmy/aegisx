# TSecBench 定制镜像 — 实施计划（v3，已实施）

## 状态：已构建并验证（2026-09-09）

最终产物 `aegisx/tsecbench:v4`：**未压缩 2.78GB，gzip 压缩后 885MB**（达标 <1GB）。
实现落在 `containers/tsecbench/`（Dockerfile + tuning.sed + README），使用方式见该
README。以下计划正文保留作为决策记录。

## 关键实施记录

- 服务端以 bun bundle 打包（13MB 单文件替代 190MB node_modules），布局约束
  `/opt/aegisx/server/dist` + `/opt/aegisx/drizzle`（相对路径解析迁移文件）。
- 调优不走 env：`tuning.sed` 在构建期改写源码后打包——promptHint（TSecBench 平台简报）、
  `maxConcurrentTargets ?? 3`、`stopSubmitterOnSolve ?? true`。
- 体积迭代：v1 5.08GB（压缩 1712MB）→ v3 1.79GB（591MB，修复 seclists 剪枝静默失败、
  去 angr/exploitdb/openjdk、qemu 裁 4 架构、hacktricks 剥图）→ v4 2.78GB（885MB，
  预算有富余后按实测价值加回：angr、openjdk/jdb、Web-Content 全目录、
  hacktricks-cloud、qemu mips/mipsel）。
- 已验证：Python 导入（含 angr）、词表与别名、jdb、server 启动建库、三处 tuning 在
  bundle 中生效、ENVIRONMENT.md 离线段替换。
- cpu-features/ssh2 原生依赖以占位 .node 文件满足 bun build 的静态解析（运行时
  不走该路径，与 allinone 一致）。
- 仍未内置（压缩体积代价）：exploitdb（+200MB）、ghidra（+400MB）。

---

## 结论

独立 all-in-one 单镜像，目标体积 **< 1 GB**（预算 ~950 MB，压缩后 ~700 MB）。
不从 `full` 分叉，基座用 `kalilinux/kali-rolling`（143 MB），只装 tsecbench 实测用到的
工具，服务端以 **bundle 形式**打包（13 MB）替代 190 MB 的 node_modules。

**v1/v2 已废弃**。v3 的三处修正来自本次查证：

| 用户要求 | 落实 |
|---|---|
| < 1 GB | 已实测预算 948 MB；关键发现：服务端可 bundle 到 13 MB（实测可启动） |
| kali-rolling vs solver:minimal 的区别 | 见 §2，minimal 是"Kali + 通用 CTF 工具链"的预制品（845 MB，含 chisel/git/7zip/perl 等无关内容）；kali-rolling 是裸 Kali（143 MB），只装需要的 |
| 配置改文件注入，不再做 env | 见 §5：`/data/config.json` + `prompt_templates` 表 + `scheduler_config` 行，全部可在构建期或首启前落盘 |

---

## 一、kali-rolling 与 solver:minimal 的区别

| | `kalilinux/kali-rolling` | `aegisx/solver:minimal` |
|---|---|---|
| 体积 | **143 MB** | 845 MB |
| 内容 | 裸 Kali 根文件系统 + apt | Kali + 基础工具链 + Python venv(426MB) + 词表 |
| 已含 | apt、bash、coreutils | + git(49MB)、chisel(10MB)、7zip(6MB)、perl(45MB)、systemd、gdb、binutils、pwntools/z3/sympy/unicorn 等 |
| 定位 | 供上层精确裁剪的基座 | 通用档的一档，给"什么题都可能出"的场景 |
| 对 tsecbench | **合适**：按需装 | 不合适：约 500 MB 是 tsecbench 用不到或需换版本的内容 |

关键：minimal 的 426 MB venv 里，`sympy`(72MB) 与 `unicorn`(56MB) 都不是 tsecbench 的
必需项（sympy 无任何包依赖它；unicorn 仅 pwntools 间接用）。裸 kali + 精确 pip 安装更省。

---

## 二、体积预算（实测）

| 项 | 实测 | 说明 |
|---|---|---|
| kali-rolling 基础 | 143 MB | 已 pull 确认 |
| base toolchain（apt，精简） | ~250 MB | 见 §3.1；已剔除 git/perl/7zip 等 |
| Python venv | ~300 MB | 含 pwntools/z3/capstone/angr 等，裁掉 sympy/unicorn |
| 词表 | ~140 MB | rockyou 133MB + 精选 seclists 2MB |
| server bundle | 13 MB | **实测**：`bun build` 后 13.1 MB，已验证可启动 |
| drizzle + web 产物 | ~13 MB | drizzle 220KB + web dist 12MB |
| bun 运行时 | 80 MB | 单二进制 |
| SDK + 环境文档 | ~5 MB | |
| **合计** | **~948 MB** | 压缩后约 700 MB |

> 三个可调旋钮（若需进一步压）：去掉 angr(~120MB)、rockyou 换小词表、去掉 tesseract。

---

## 三、工具集

### 3.1 系统（有实测调用）

```
curl wget binutils gdb strace ltrace file procps psmisc ripgrep fd-find jq yq bc
zip unzip netcat-openbsd ncat socat sshpass openssh-client ftp telnet dnsutils
iproute2 net-tools nmap masscan ffuf gobuster feroxbuster dirsearch wfuzz sqlmap
hydra nikto default-mysql-client php-cli php-mysql qemu-user-binfmt perl
tesseract-ocr python3.13-venv
```

**不装**（零调用或可省）：`git`(49MB)、`7zip`(6MB)、`chisel`(10MB)、`systemd`、
`pwndbg`、`wine`、`playwright`、`ghidra`、`volatility3`、AD 套件、`hashcat`、`john`、
`impacket`、`tshark`、`steghide/zsteg/foremost/exiftool`、`smbclient`、`wpscan`。

### 3.2 Python venv

```
pwntools pycryptodome pycryptodomex gmpy2 z3-solver capstone pyelftools requests
scapy telnetlib3 gradio_client websockets pyyaml aiohttp pymysql
```
可选：`angr`（4 次调用，约 120 MB）——**建议默认不装**，运行期按需 `pip install`。

### 3.3 词表

`rockyou.txt`（133 MB）+ seclists 精选 8 个文件（2 MB，实测）：
`common.txt`、`raft-small-words`、`raft-medium-words`、`raft-medium-files`、
`raft-medium-directories`、`raft-large-directories`、`directory-list-2.3-medium`、
`burp-parameter-names`。

---

## 四、构建结构

```
containers/tsecbench/Dockerfile
  ├─ stage: web-builder   (oven/bun → vite build)
  ├─ stage: server-bundle (oven/bun → bun build --target=bun → 13MB)
  └─ stage: runtime       (kalilinux/kali-rolling)
        ├─ apt 工具集（§3.1）
        ├─ venv（§3.2）
        ├─ 词表（§3.3）
        ├─ bun 二进制 + server bundle + drizzle + web dist
        ├─ SDK + tsec 环境文档
        ├─ /opt/aegisx-preset/{config.json, prompt-templates.json, scheduler-config.json}
        └─ entrypoint.sh：首启前把 preset 落盘到 /data
```

**bundle 的路径约束（实测）**：`db/index.ts` 用
`resolve(import.meta.dir, "../../drizzle")`，因此镜像内布局必须是
`/opt/aegisx/server/dist/index.js` + `/opt/aegisx/drizzle`。已按此验证启动成功
（`Started development server: http://127.0.0.1:3999`，并自动建库）。

---

## 五、配置注入（改文件，不用 env）

用户要求不再做 env。现有三类配置都可直接落文件：

| 配置 | 载体 | 注入方式 |
|---|---|---|
| 全局 settings + provider/model | `/data/config.json` | 构建期放 `/opt/aegisx-preset/config.json`，entrypoint 首启时 `cp` 到 `/data`（仅当不存在） |
| 提示词模板 | `prompt_templates` 表（`plugin='builtin'`） | 同上：preset JSON，首启前由 entrypoint 写入，或由一段一次性 bootstrap 脚本插入 |
| 赛事调度策略 | `scheduler_config` 行（DB） | 同上 |

**tsecbench 预设值**：

```
config.json:
  container.image            = aegisx/tsecbench        （self，local backend 下仅占位）
  container.networkMode      = container:tsec-vpn
  scheduler.maxConcurrentAgents = 4
  agent.defaultModelRef      = <由使用者填>

scheduler_config:
  maxConcurrentTargets  = 3
  stopSubmitterOnSolve  = true      ← 评测场景解出即停（已实现，见 §6）
  stopSiblingsOnSolve   = true
  stopTargetOnSolve     = true
  blockSpawnOnSolved    = true
  nextTaskPolicy        = eager
  urgentTeamMessages    = true
```

**待补的小改动**：`bootstrap.ts` 的 `ensureScheduler` 目前只写 model/instruction，
不写策略项。若走文件注入则不需要改它——但需要确认 entrypoint 的落盘时机早于
bootstrap 建赛事（否则 DB 行已按默认值建好）。两条路径：
- A（推荐）：entrypoint 先落 `config.json`，再启动 server；`scheduler_config` 用
  一个启动前 SQL 脚本插入（需先建库，有先后依赖）。
- B：扩展 `ensureScheduler` 读 `scheduler_config` 预设（需改代码，且用户不想要 env）。

> 这是一处**设计待定项**，需要确认后实施（见 §8）。

---

## 六、提示词特调

**重要：`d0bf545` 已提交一批提示词特调**（`prompt-defaults.ts` 已含"长命令后台化"、
"卡住优先新开 agent"、"破题止损"、"flag 格式权威"、category 语义等）。因此本镜像
**不再重复这些**，只补 tsecbench 平台特有项：

1. **flag 格式** `flag{<uuid>}`（平台固定，本轮 68 个已接受 flag 全为此格式）。
2. **多 flag 进度实时注入**，不读描述里的同步时刻冻结计数（b-02 永远是"已正确 0 个"）。
3. **靶机永不过期** → `extend_target` 无意义；`get_target` 降低轮询（适配器已有 3s 缓存）。
4. **409 语义**：平台最多 3 实例，等槽位、退避，不 hammer（本轮 230 次 409）。
5. **`category` 是难度**（easy/medium/hard），不是题型。

---

## 七、交付物

| 文件 | 内容 |
|---|---|
| `containers/tsecbench/Dockerfile` | 三段式 all-in-one 构建 |
| `containers/tsecbench/entrypoint.sh` | 预设落盘 + 启动 |
| `containers/tsecbench/preset/config.json` | 全局设置预设 |
| `containers/tsecbench/preset/prompt-templates.json` | 提示词预设（含 §6 五项） |
| `containers/tsecbench/preset/scheduler-config.sql` 或 `.json` | 调度策略预设 |
| `containers/tsecbench/README.md` | 构建/运行/预设说明 |
| `docs/usage.md` | 加一节 tsecbench 镜像 |
| `containers/solver/Dockerfile` | 本轮已补 3 缺口 + 词表别名 + time（**未构建**） |

---

## 八、待确认

1. **配置注入路径**：§5 的 A（entrypoint 落文件 + 启动前 SQL）还是 B（改
   `ensureScheduler`）。A 不动代码但有启动顺序依赖；B 动代码但更干净。
2. **angr 是否装进镜像**（120 MB / 4 次调用）。默认不装、运行期按需。
3. **镜像名** `aegisx/tsecbench`。
4. **是否现在构建验证**（用户此前说不构建；本轮只改文件）。
5. `containers/solver/Dockerfile` 的缺口补充是否随本计划一起构建。

---

## 九、验收标准

1. `docker buildx build -f containers/tsecbench/Dockerfile --target runtime -t aegisx/tsecbench:latest .` 成功。
2. **`docker images` 中 < 1 GB**（硬指标）。
3. 容器内 `python3 -c "import pwn, z3, capstone, telnetlib3, gradio_client, websockets, yaml, aiohttp, pymysql"` 全通过。
4. server bundle 启动成功（`Started development server`），DB 自动建库。
5. 预设生效：`config.json` 与 `scheduler_config` 行含 tsecbench 值。
6. Web UI 在 `:3000` 可访问。
7. 小规模验证：c-07（telnet）、f2-05（rev）、a-03（web）各跑一次。
