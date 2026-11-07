#!/usr/bin/env python
"""把本仓库对插件做的改动，落到上游插件目录（H 盘）上。

为什么要这个脚本
----------------
插件仍以上游目录为开发主副本（H:\\Dlsite\\dl-ext\\price-db-plus），本仓库只是
发布副本。所以「改品牌 / 改数据源 / 加历史定位模块」这些改动必须回写到上游，
否则用户加载上游目录时，看到的还是旧品牌 + 第三方接口。

改动全部是确定性替换，可重复执行；执行前会把整个目录备份到同级 .bak-<时间>。

    python scripts/apply_upstream_patch.py --dry-run
    python scripts/apply_upstream_patch.py
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPSTREAM = os.environ.get("DLDB_UPSTREAM", r"H:\Dlsite\dl-ext\price-db-plus")
LOCAL_EXT = os.path.join(ROOT, "extension")
NODE = os.environ.get("DLDB_NODE", r"D:\nodejs\node.exe")

BRAND_OLD = "価格DB+ 券後最安"
BRAND_NEW = "DLsite Coupon Plus"
API_OLD = "https://price.maenohou.com"
API_NEW = "https://dlsite.momo-yu.com"
VERSION = "2.1.0"

# (文件, 旧串, 新串)
REPLACEMENTS = [
    ("background.js", API_OLD, API_NEW),
    ("background.js", "// インディー価格DB の lookup API を代行する。",
     "// 自前の価格 DB (dlsite.momo-yu.com) の lookup API を代行する。"),
    ("content.js", BRAND_OLD, BRAND_NEW),
    ("content.js", "//   1. インディー価格DB (price.maenohou.com) — 過去の価格推移。クーポンは考慮しない",
     "//   1. 自前の価格 DB (dlsite.momo-yu.com) — 過去の価格推移。クーポンは考慮しない"),
    ("content.js", "// インディー価格DB の履歴", "// 自前の価格 DB の履歴"),
    ("content.js", "const target = new URL(remote.url, 'https://price.maenohou.com');",
     "const target = new URL(remote.url, 'https://dlsite.momo-yu.com');"),
    ("content.js", "if (target.hostname.endsWith('.maenohou.com')) {",
     "if (target.hostname === 'dlsite.momo-yu.com' || target.hostname.endsWith('.momo-yu.com')) {"),
    ("cart-content.js", BRAND_OLD, BRAND_NEW),
    ("options.html", BRAND_OLD, BRAND_NEW),
    ("options.js", BRAND_OLD, BRAND_NEW),
]

# 从仓库直接覆盖到上游的文件
COPIES = [
    ("lib/lowpos.js", "lib/lowpos.js"),
    ("icons/icon-48.png", "icons/icon-48.png"),
    ("icons/icon-96.png", "icons/icon-96.png"),
    ("icons/icon-128.png", "icons/icon-128.png"),
]


def patch_manifest(path, dry_run):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    before = json.dumps(data, ensure_ascii=False, sort_keys=True)

    data["name"] = BRAND_NEW
    data["version"] = VERSION
    data["host_permissions"] = ["https://dlsite.momo-yu.com/*", "https://www.dlsite.com/*"]
    action = data.setdefault("action", {})
    action["default_title"] = BRAND_NEW
    for cs in data.get("content_scripts", []):
        js = cs.get("js") or []
        if any(p == "content.js" or p.endswith("/content.js") for p in js):
            if "lib/lowpos.js" not in js:
                js.append("lib/lowpos.js")
        cs["js"] = js

    after = json.dumps(data, ensure_ascii=False, sort_keys=True)
    if before == after:
        return False
    if not dry_run:
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(UPSTREAM):
        print("上游目录不存在：%s" % UPSTREAM)
        return 1

    if not args.dry_run:
        backup = "%s.bak-%s" % (UPSTREAM, time.strftime("%Y%m%d-%H%M%S"))
        shutil.copytree(UPSTREAM, backup)
        print("已备份到 %s" % backup)

    changed = []

    for rel, old, new in REPLACEMENTS:
        path = os.path.join(UPSTREAM, rel)
        if not os.path.exists(path):
            print("跳过（不存在）：%s" % rel)
            continue
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        if old not in text:
            continue
        if not args.dry_run:
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(text.replace(old, new))
        changed.append("%s ← %s" % (rel, old[:24]))

    if patch_manifest(os.path.join(UPSTREAM, "manifest.json"), args.dry_run):
        changed.append("manifest.json ← 名称/版本/权限/脚本列表")

    for src, dst in COPIES:
        src_path = os.path.join(LOCAL_EXT, src)
        dst_path = os.path.join(UPSTREAM, dst)
        if not os.path.exists(src_path):
            print("跳过（仓库没有）：%s" % src)
            continue
        same = os.path.exists(dst_path) and open(src_path, "rb").read() == open(dst_path, "rb").read()
        if same:
            continue
        if not args.dry_run:
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            shutil.copy2(src_path, dst_path)
        changed.append("%s ← 从仓库覆盖" % dst)

    if args.dry_run:
        print("将修改 %d 处：%s" % (len(changed), "；".join(changed) or "无"))
        return 0

    problems = []
    for rel, _, _ in REPLACEMENTS:
        path = os.path.join(UPSTREAM, rel)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for word in ("価格DB", "maenohou"):
            if word in text:
                problems.append("%s 仍含「%s」" % (rel, word))
        if rel.endswith(".js") and os.path.exists(NODE):
            proc = subprocess.run([NODE, "--check", path], capture_output=True, text=True)
            if proc.returncode != 0:
                problems.append("%s 语法错误" % rel)

    print("上游修改 %d 处：%s" % (len(changed), "；".join(changed) or "无"))
    if problems:
        print("校验失败：")
        for p in problems:
            print("  - %s" % p)
        return 1
    print("校验通过：无旧品牌/第三方残留，JS 语法正常")
    return 0


if __name__ == "__main__":
    sys.exit(main())
