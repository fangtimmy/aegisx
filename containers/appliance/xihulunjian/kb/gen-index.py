#!/usr/bin/env python3
"""Regenerate INDEX.md from challenges/*/meta.json. Run from kb/ directory."""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> None:
    rows = []
    for entry in sorted(os.listdir(os.path.join(HERE, "challenges"))):
        meta_path = os.path.join(HERE, "challenges", entry, "meta.json")
        if not os.path.isfile(meta_path):
            continue
        m = json.load(open(meta_path))
        quali = m.get("quali")
        reh = m.get("rehearsal")
        flags = m.get("flags") or {}
        atts = m.get("attachments") or []
        rows.append(
            {
                "key": m["key"],
                "names": m.get("names") or [m["key"]],
                "category": m.get("category") or "?",
                "policy": m.get("flag_policy") or "unknown",
                "status": m.get("status") or "todo",
                "label": quali["label"] if quali else "-",
                "quali_solved": quali["solved"] if quali else None,
                "reh": bool(reh),
                "reh_solved": (reh or {}).get("solved"),
                "quali_flag": flags.get("quali"),
                "reh_flag": flags.get("rehearsal"),
                "atts": [(a["filename"], a.get("sha256")) for a in atts],
            }
        )

    lines = [
        "# 西湖论剑决赛知识库索引",
        "",
        "初赛 60 题全量 + 决赛测试新题。条目目录 `challenges/<key>/`：`SOLVE.md`（确定性操作手册）"
        "+ `exp/`（可直接执行的脚本）+ `meta.json`（本表数据源）。",
        "",
        "## 匹配步骤（按顺序）",
        "",
        "1. 按题名精确匹配 `names` 列（含初赛题号别名）；",
        "2. 按附件文件名匹配；",
        "3. 对工作区附件算 `sha256sum` 匹配指纹列（附件内容被复用时题名可能已变）；",
        "4. 均未命中 → 本库无此题，走正常解题流程。",
        "",
        "flag_policy 含义：`static`=附件可复现 flag；`dynamic`=打实例取 flag，禁止提交旧值；"
        "`rotated`=附件同但 flag 已轮换，以 exp 现算为准；`unknown`=待研究。",
        "status 含义：`verified`=exp 已实跑验证；`authored`=已写 runbook 未实跑；"
        "`researched`=有研究结论；`todo`=仅有元数据。",
        "",
        "| key | 题名/别名 | 分类 | policy | status | 初赛 | 测试赛 | 附件指纹 (sha256 前 12) |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        names = " / ".join(r["names"])
        quali = "解出" if r["quali_solved"] else ("未解" if r["quali_solved"] is not None else "-")
        reh = ("解出" if r["reh_solved"] else "出现") if r["reh"] else "-"
        atts = "<br>".join(f"`{fn}` `{(sha or '')[:12]}`" for fn, sha in r["atts"]) or "-"
        lines.append(
            f"| {r['key']} | {names} | {r['category']} | {r['policy']} | {r['status']} "
            f"| {quali} | {reh} | {atts} |"
        )
    with open(os.path.join(HERE, "INDEX.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"INDEX.md: {len(rows)} entries")


if __name__ == "__main__":
    main()
