# Solver 容器安全边界审查（静态）

## 范围与方法

- 对象：`containers/solver/`（Dockerfile、ENVIRONMENT.md、README.md、solver-cache.py）+ 服务端容器创建/执行代码（`apps/server/src/run/container/container-manager.ts`、`apps/server/src/run/agent-factory.ts`、`apps/shared/settings-schema.ts`、`apps/server/src/run/workspace-resolver.ts`、`apps/server/src/infrastructure/agent-auth.ts`、`apps/server/src/platforms/targets.ts`）。
- 方法：纯文件级静态分析 + `git show b08b057` diff 核对。全程未执行任何 docker 命令。凡未经运行时验证的结论均标注「推断」。
- 威胁模型前提：本地单兵部署、单操作者；隔离目标是「solver ↔ host 数据 / solver ↔ 其他 challenge」，而非「solver ↔ 操作者」。Agent 本身被视为半可信（会执行任意解题命令）。

## b08b057 修复验证

逐项对照 commit 声明与 `containers/solver/Dockerfile` 现状：

| 声明 | 验证 | 证据 |
|---|---|---|
| dpkg path-exclude 去 doc/man/locale | ✅ | Dockerfile:20-22 写入 `/etc/dpkg/dpkg.cfg.d/excludes`，位于首个 apt 层之前，覆盖后续所有包安装 |
| seclists 裁 Fuzzing | ✅ | Dockerfile:48 `rm -rf /usr/share/seclists/Fuzzing` |
| rockyou 单份 | ✅ | Dockerfile:47 `gzip -df`（解压并删除 .gz）。注意 `|| true` 吞错，见 F6 |
| playwright cache mount + 拷贝 | ✅ | Dockerfile:106-111。下载进 cache mount（target=`/root/.cache/ms-playwright`），再 `cp -a` 到 `/opt/ms-playwright`。cache mount 内容不进镜像层，故最终只带一份浏览器，无重复 |
| wine64 移入 volatile 尾层 + 绝对路径 wrapper | ✅ | Dockerfile:162-166（apt 装 wine64）、171-174（wrapper `exec /usr/lib/wine/wine64 "$@"`） |
| pycdc/pycdas 源码构建 | ✅ | Dockerfile:126-131，cmake 构建 → `install -m755` 到 `/usr/local/bin`，源码与构建目录清理 |
| ghidra 软链去版本硬编码 | ✅ | Dockerfile:64 `ln -sfn /opt/ghidra_*/support/analyzeHeadless ...`（构建期 shell 展开 glob） |
| apt 源 sed 兼容 https | ✅ | Dockerfile:24 `sed -Ei "s@https?://http\.kali\.org/kali@..."` |
| getcap 全扫剥离 + 断言清零 | ✅ 且位置正确 | 见下方专节 |
| container-manager.ts 注释同步 | ✅ | container-manager.ts:141-146 更新了 file-caps 说明 |

### getcap 剥离逻辑的正确性

剥离层位于 **Dockerfile:181-182**，是镜像的**最后一个 RUN**：

```dockerfile
RUN getcap -r / 2>/dev/null | cut -d' ' -f1 | xargs -r -n1 setcap -r && \
    test -z "$(getcap -r / 2>/dev/null)"
```

- 其后仅有 `WORKDIR /workspace` 与 `CMD`（纯元数据），**没有任何后续 COPY/RUN**。pip install（L86）、gem install（L122）、pycdc 编译（L126）、npm install（L140）、wine64 apt（L162）全部先于剥离层 —— 即使这些步骤引入过 file caps，也会被末尾全扫清掉，**不存在绕过**。
- 该 RUN 未挂载任何 cache mount，扫描时 `/var/cache/*` 等 mount 目标不在文件系统内，不会漏扫也不会误报。
- 断言 `test -z "$(getcap -r /)"` 是硬失败（构建期即报错），自校验成立。
- 边界情况：`cut -d' ' -f1` 对含空格路径会取错字段导致 `setcap -r` 报错，但该文件仍留在清单里，最终断言会兜底失败 —— 逻辑闭环。系统目录实际不含空格路径，推断无影响。
- **真正的残余缺口在运行时**，见 F1。

## 发现

### F1 · P2 · 运行期 apt 安装会重新引入 file-cap 二进制，且容器内无法自愈

- 位置：`containers/solver/Dockerfile:176-182` + `containers/solver/ENVIRONMENT.md:74-81`
- 证据：剥离只发生在**构建期最后一层**。ENVIRONMENT.md「缺工具时的安装 SOP」明确引导 agent 在运行期 `apt-get update && apt-get install -y <pkg>`。Debian/Kali 部分网络工具 postinst 会设置 file caps（如 tcpdump 的 `cap_net_admin,cap_net_raw=ep`；本仓库 commit 信息证实 Kali 的 nmap 即带 `net_bind_service+net_admin+net_raw` 并曾复现 EPERM）。
- 场景：agent 按 SOP 装 tcpdump/nmap 类包 → 新二进制 file caps 含 `net_admin`，超出容器 bounding set（仅 `NET_RAW`）→ no-new-privileges 下 exec 直接 EPERM。容器经 `CapDrop: ["ALL"]`（container-manager.ts:147）后无 `CAP_SETFCAP`，**agent 在容器内连 `setcap -r` 都做不了**；可行 workaround 只有 `cat /usr/bin/tcpdump > /tmp/t && chmod +x /tmp/t`（重写副本丢 xattr），但 ENVIRONMENT.md 对此只字未提。
- 定性：可用性问题而非提权问题（no-new-privileges 保证这些 caps 不会被利用），但恰好打在本项目核心工作流（agent 自助装工具）上。

### F2 · P2 · 默认 bridge + NET_RAW：solver 对 host 局域网有完整出站与原始包能力，无网络隔离层

- 位置：`apps/server/src/run/container/container-manager.ts:147-156`；`apps/shared/settings-schema.ts:250-260`（`container.networkMode` 默认空串）
- 证据：创建参数只有 `CapDrop ALL / CapAdd NET_RAW / no-new-privileges / IpcMode none / Tmpfs /tmp` 与可选 `NetworkMode`；全仓 grep 无任何 `createNetwork`、iptables、自定义网段代码。网络模式要么默认 bridge，要么整体共享 VPN 容器的 netns（`container:<name>`），没有中间粒度。
- 场景：CTF 目标是远端平台实例（platforms/adapters/*.ts 经 HTTP 管理，非本地容器），因此「目标网段 vs host 局域网」之间**没有防火墙语义**——solver 在默认 bridge 上 NAT 出站，可触达 host 内网、局域网设备，且持 `NET_RAW` 可发 raw socket / ARP 类流量（nmap -sS、scapy 正是依赖它）。半可信 agent 被 prompt injection 后对 LAN 的探测/攻击面完全敞开。
- 定性：单兵本地部署下的已知取舍（commit 信息显示 NET_RAW 是刻意恢复的），但代码与文档均未把这个边界显式写下来。

### F3 · P3 · getcap 清零断言靠「人肉层序约定」维持，无机制保障

- 位置：`containers/solver/Dockerfile:159-182`
- 证据：「Volatile package additions」注释鼓励在此区域追加 apt 层，而剥离+断言是固定写在末尾的一条 RUN。任何人将来在 L181 **之后**追加 `RUN apt-get install ...`（Dockerfile 追加层是最自然的改动方向），新 file caps 将绕过断言进入镜像，nmap -sS 式 EPERM 复发且无人发现。
- 建议（见「建议」#1）：CI 校验或把断言改为独立的最终 stage。

### F4 · P3 · wine wrapper 的绝对路径无存在性断言，包布局漂移即静默断裂

- 位置：`containers/solver/Dockerfile:168-174`
- 证据：`printf '#!/bin/sh\nexec /usr/lib/wine/wine64 "$@"\n' > /usr/local/bin/wine64`。该路径是 kali-rolling 当前 wine64 包的布局（commit 信息与 ENVIRONMENT.md §Windows exe 显示实测通过，含 Rosetta 噪音描述）；但构建过程不检查 `/usr/lib/wine/wine64` 是否存在——基础镜像 digest 固定（Dockerfile:1）时安全，一旦升级 digest 而 wine 包迁移 loader 路径（Debian 多年历史上有 `/usr/lib/wine/` ↔ `/usr/lib/x86_64-linux-gnu/wine/` 变动），`wine`/`wine64`/`wineserver` 三个入口同时静默失效。
- 挂载布局影响：核对全部 bind（`/workspace` rw、`/opt/aegisx-sdk:ro` dev 覆盖、scheduler 专用 `/challenges:ro`），无一遮蔽 `/usr/lib` 或 `/usr/local/bin`，**当前挂载布局下 wrapper 不会因挂载失效**；风险仅在包版本漂移。`ghidra-analyze`（L64）、`python→/opt/venv`（L99-100）、pycdc（L130）同为绝对路径软链/安装，同理安全。

### F5 · P3 · GitHub Release 二进制无完整性校验（供应链）

- 位置：`containers/solver/solver-cache.py:12-27` + `Dockerfile:60-76`
- 证据：14 个 release artifact（fscan、dddd、katana、pwndbg.deb 等）按 URL 直拉后直接 `install -m755` 进 `/usr/local/bin`，无 sha256/sha512 pin。基础镜像反而有 digest pin（Dockerfile:1），防护不对称。缓存命中逻辑（solver-cache.py:48）意味着**首次构建**的产物会被长期复用，投毒窗口 = 首次下载时刻。
- 场景：上游账号/release 被篡改 → 工具镜像内置后门，随每道题的 solver 执行。单兵自用风险可接受，但这是镜像里唯一的未校验外部代码入口。

### F6 · P3 · ENVIRONMENT.md 与镜像实际的偏差（文档漂移点汇总）

- 位置：`containers/solver/ENVIRONMENT.md`
- 逐条核对：
  - 「`/opt/solver/knowledges`、`/opt/solver/tools` 只读」（L8-9）：**非强制只读**。它们是普通镜像目录，agent 以 root 身份完全可写（写入落在容器层、随容器销毁丢弃）。「只读」是给 agent 的行为约定，不是挂载语义。
  - 「rockyou (`/usr/share/wordlists/rockyou.txt`)」（L66）：依赖 Dockerfile:47 的 `gzip -df ... || true`——若 Kali 上游改名/移除该文件则静默跳过，镜像里既无 `.txt` 也无 `.gz`，文档承诺落空且构建不报错。
  - netexec / evil-winrm / responder / hashcat / john / binwalk / sleuthkit / testdisk / masscan / socat / dig 等（L55-67）：均未在 Dockerfile 显式安装，推断来自 `kali-linux-headless` 元包（Dockerfile:29）；静态无法核实具体成员，属合理推断而非事实。
  - 未记录 `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`（Dockerfile:105）：agent 若自行 `playwright install` 会装到别处，浪费空间且与镜像内浏览器脱节。
  - 未记录 F1 所述「运行期安装的带 cap 包会 EPERM」——这是与本镜像安全模型最相关的一条缺失。
  - 其余核对一致：`/tmp` tmpfs 1g 可执行（= settings-schema.ts:241 默认 `"1g"` + container-manager.ts:154 `rw,exec`）✅；「出厂没有 apt 索引」✅（apt lists 是 cache mount 不进镜像）；seclists Fuzzing 已裁剪 ✅。

### F7 · P3 · 同 challenge 容器内 agent 相互可见（含 token），跨 challenge 才是隔离边界

- 位置：`apps/server/src/run/agent-factory.ts:119-137, 800-804`；`apps/server/src/infrastructure/agent-auth.ts:52-127`
- 证据：一道题的所有 agent 共享一个容器（`aegisx-ws-<cid8>`），身份凭据走 per-exec env（`AEGISX_AGENT_ID`/`AEGISX_TOKEN`）。同容器内 root 进程可读 `/proc/<pid>/environ` 与 `ps` 抓到他人 token；token 权限面由 `verdict()` 收敛为「自身 face + channels」（solver）/「本 event 管理面」（orchestrator），盗用同 event 他人的 orchestrator token 可越权管理整个 event 的队列/agent。
- 定性：同题协作模型下可接受，列出以固化信任边界——**跨 challenge 由「一题一容器 + 仅挂自己的 workspace」实现**（solverSdkContainerOpts 无 `/challenges` 挂载，agent-factory.ts:124-137 vs schedulerSdkContainerOpts:101-117），这条边界本身是干净的。

### F8 · Info · 运行时配置基线快照（无问题项，供后续回归比对）

来源均为 `container-manager.ts:126-158` + settings 默认值：

| 项 | 值 | 备注 |
|---|---|---|
| CapDrop/CapAdd | `ALL` / `NET_RAW` | NET_RAW 为 nmap -sS/scapy/naabu/tshark 刻意保留 |
| SecurityOpt | `no-new-privileges` | 与构建期 cap 剥离配套 |
| Rootfs | 可写（无 ReadOnlyRootfs） | 支撑 ENVIRONMENT.md 的 pip/apt 安装 SOP |
| tmpfs | `/tmp` `rw,exec,size=1g` | exec 显式开启（docker 默认 noexec）✓ |
| IpcMode | `none` | ✓ |
| Resources | 2 CPU / 2048MB / PidsLimit 256 | settings 默认 |
| Network | 默认 bridge（可切 `container:<vpn>`） | 见 F2 |
| 用户 | root（Dockerfile 无 USER 指令） | 单兵模型接受 |
| docker socket | **未挂入任何容器** | dockerode 仅 host 侧使用（container-manager.ts:104-109）；extraBinds 全量核对只有 `/challenges:ro` 与 dev `/opt/aegisx-sdk:ro` 两类 |
| 挂载 | `<dataDir>/events/<eid>/challenges/<cid>/workspace:/workspace`（rw） | workspace-resolver.ts:24-40 |
| Cmd | 显式 `sleep infinity` | container-manager.ts:131，防镜像 CMD 劫持角色 ✓ |
| AutoRemove | true | 容器停止即销毁 |

## 建议

1. **把 cap 清零从「最后一条 RUN」升级为结构性约束**（对应 F1/F3）：最简做法是把剥离+断言挪进一个独立 final stage（`FROM scratch`/`COPY --from` 不现实，可改用 CI 脚本对构建产物跑 `getcap -r /` 断言）；同时在 ENVIRONMENT.md 安装 SOP 加一句：装完网络工具若 exec EPERM，用 `cat 原路径 > 新副本 && chmod +x` 剥离 xattr 使用。
2. **给 release artifact 加 checksum pin**（F5）：solver-cache.py 的 DOWNLOADS 增加 `sha256` 字段，下载后校验；成本一次性。
3. **网络边界显式化**（F2）：至少在 README/ENVIRONMENT.md 写明「solver 拥有对 host 局域网的完整出站 + NET_RAW」；若要收口，优先方向是为 solver 建自定义 bridge + 只放行目标平台网段/公网，而不是依赖默认 bridge。
4. **wine wrapper 加构建期断言**（F4）：`test -x /usr/lib/wine/wine64 || exit 1`，一行成本消除静默断裂。
5. **rockyou 解压加断言**（F6）：`test -s /usr/share/wordlists/rockyou.txt` 替代 `|| true` 吞错。
6. 文档微调（F6）：knowledges/tools 的「只读」标注改为「约定只读（容器层可写但不持久）」；补记 `PLAYWRIGHT_BROWSERS_PATH`。

## 未确认事项

- `kali-linux-headless` 元包的实际成员清单（netexec/hashcat/john/binwalk/masscan/socat/dig/sleuthkit/testdisk/evil-winrm/responder 等是否在镜像内）——需在容器内 `dpkg -L` 或 `which` 验证，本次静态无法判定（推断大概率在）。
- 当前 `/usr/lib/wine/wine64`、`/usr/lib/wine/wineserver` 路径与 pinned digest（sha256:3d3bc4…）下 wine64 包的真实布局是否吻合——commit 信息表明作者实测通过，但本次未运行验证。
- 镜像体积构成（16.3G 中各层占比）与进一步瘦身排序：基于 Dockerfile 推断，大头依次为 kali-linux-headless 全家桶、Python venv（angr/scipy/opencv 等）、ghidra、playwright chromium、llvm-21、golang/jdk/ruby；build-essential/cmake 因「缺工具安装 SOP」需要而保留，不宜裁。均为推断，未经分层测量。
- macOS Docker Desktop（Rosetta/virtiofs）下 root-in-container 对宿主 workspace 文件的实际权限映射（chmod/chown 影响范围）——未做运行时验证。
