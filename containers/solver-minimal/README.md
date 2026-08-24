# Solver 容器镜像：full / minimal

同一套 server 代码可用两种 solver 镜像。创建 run 时通过镜像字段选择
（settings 默认项 `container.image` 或单次 run 的 image 参数）。

| | full (`containers/solver/`) | minimal (`containers/solver-minimal/`) |
|---|---|---|
| tag | `aegisx/solver:kali` | `aegisx/solver:kali-pre8-minimal` |
| 定位 | 全工具面作战（比赛实战用） | 快速部署 / 评审环境验证 |
| 基础包 | `kali-linux-headless` 元包（~1500 包） | 精选核心集（~80 包） |
| 逆向 | Ghidra headless、jadx、apktool、rizin、qemu-user | pycdc/pycdas、objdump/readelf |
| Pwn | gdb+pwndbg、one_gadget、pwninit、bkcrack 等 | gdb+pwndbg、one_gadget、pwninit |
| Web | nmap、ffuf、dirsearch、feroxbuster、httpx、nuclei、katana、naabu、dalfox 等 | nmap、sqlmap、ffuf |
| Crypto/Misc venv | pwntools、angr、impacket、volatility3、playwright、opencv 等 | pwntools、scapy、pycryptodome、gmpy2、sympy、z3、numpy 等 |
| AD/内网 | smbclient/krb5/netexec 全套 + kerbrute/fscan/dddd/cloudfox | 无 |
| 知识库 | 6 个仓库（含 hacktricks/vulhub/libc-database） | PayloadsAllTheThings + InternalAllTheThings |
| Windows PE | wine64 | 无 |
| 镜像体积 | ~16 GB | **2.16 GB**（实测 2026-08-24） |
| 冷构建时间 | ~20-30 分钟（含 kali 元包解包与 Ghidra/Playwright 等大件下载） | 缓存挂载命中时 ~90 秒；全冷构建预计 6-10 分钟 |

## 构建

```sh
# full（context = 仓库根）
docker buildx build -f containers/solver/Dockerfile -t aegisx/solver:kali .

# minimal
docker buildx build -f containers/solver-minimal/Dockerfile \
  -t aegisx/solver:kali-pre8-minimal .
```

两个 Dockerfile 共享 `containers/solver/solver-cache.py` 与同一组 buildx 缓存挂载
（apt/git/downloads/pip），先后构建时第二遍的下载层全部命中缓存。

## 取舍说明

minimal 保持"能解题"的最小核心面：Web/Pwn/Crypto/Stego/Misc 常规题可直接做。
缺省能力（Ghidra 反编译、浏览器自动化、内存取证、AD 套件）在 minimal 中不可用，
agent 会自然回退到静态分析路径；对完整能力依赖强的题目请用 full 版。

注意：默认 solver 系统提示词提到 `ghidra-analyze` 等 full 版入口；使用 minimal 时
建议在设置中微调提示词（设置页 → 提示词模板），或在容器内忽略不存在的工具。

## 构建实测记录

2026-08-24，Apple Silicon (OrbStack) 实测：

- minimal 镜像体积 **2.16 GB**（同机 full 版 `aegisx/solver:kali` 为 16.3 GB，缩减 ~87%）
- warm-cache 构建（apt/git/downloads/pip 缓存挂载命中）各层实测：
  pwndbg+pwninit 15.6s · 知识库克隆 0.9s · venv pip 29.7s · gems 21.9s ·
  pycdc 编译 13.5s · 元数据与导出 ~7s，合计 **~89 秒**
- 冒烟验证：`aegisx/solver:kali-pre8-minimal` 起 run → 容器内 bash（md5sum）、
  workspace 文件写入、finish_run 生命周期、运行时切模型、手动 flag 本地接受，
  全链路通过（详见测试文档）
