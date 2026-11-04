#!/usr/bin/env python
"""从上游扩展目录同步源码到本仓库，并重打品牌/数据源补丁。

背景
----
扩展仍在 `H:\\Dlsite\\dl-ext\\price-db-plus` 持续开发，本仓库的 `extension/`
是它的发布副本。直接复制会把「価格DB／maenohou」带回仓库，所以同步后必须
重打补丁；补丁只做确定性字符串替换，可重复执行（幂等）。

用法
----
    python scripts/sync_extension.py                # 同步 + 校验
    python scripts/sync_extension.py --dry-run      # 只看会改什么
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, "extension")
SRC = os.environ.get("DLDB_UPSTREAM", r"H:\Dlsite\dl-ext\price-db-plus")
NODE = os.environ.get("DLDB_NODE", r"D:\nodejs\node.exe")

FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "cart-content.js",
    "options.html",
    "options.js",
    "lib/i18n.js",
    "lib/coupon.js",
    "lib/cart.js",
    "lib/history.js",
]

# 顺序敏感：先替换长串，避免短串先命中
RULES = [
    ("価格DB+ 券後最安", "DLsite Coupon Plus"),
    ("インディー価格DB (price.maenohou.com)", "自前の価格 DB (dlsite.momo-yu.com)"),
    ("インディー価格DB の履歴", "自前の価格 DB の履歴"),
    ("価格DB+ の履歴", "自前の価格 DB の履歴"),
    ("https://price.maenohou.com", "https://dlsite.momo-yu.com"),
    ("price-db-plus-records-", "dlsite-coupon-plus-records-"),
    (
        "if (target.hostname.endsWith('.maenohou.com')) {",
        "if (target.hostname === 'dlsite.momo-yu.com' || target.hostname.endsWith('.momo-yu.com')) {",
    ),
    ('"version": "1.1.0"', '"version": "2.0.0"'),
    ("インディー価格DB の lookup API を代行する", "自前の価格 DB (dlsite.momo-yu.com) の lookup API を代行する"),
    ("インディー価格DB", "自前の価格 DB"),
]

FORBIDDEN = ["maenohou", "価格DB"]


def patch_text(text):
    for old, new in RULES:
        text = text.replace(old, new)
    return text


def patch_manifest(text):
    data = json.loads(text)
    data["name"] = "DLsite Coupon Plus"
    data["version"] = "2.0.0"
    data["action"]["default_title"] = "DLsite Coupon Plus"
    data["host_permissions"] = ["https://dlsite.momo-yu.com/*", "https://www.dlsite.com/*"]
    # 本仓库新增的模块：作品页在 content.js 之后挂历史定位
    # 注意不能只用 endswith("content.js")，否则 cart-content.js 也会被匹配
    for cs in data.get("content_scripts", []):
        js = cs.get("js") or []
        if any(p == "content.js" or p.endswith("/content.js") for p in js):
            if "lib/lowpos.js" not in js:
                js.append("lib/lowpos.js")
        cs["js"] = js
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def check_js(path):
    if not os.path.exists(NODE):
        return True, "未找到 node，跳过语法检查"
    proc = subprocess.run([NODE, "--check", path], capture_output=True, text=True)
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout).strip().splitlines()[:3]
    return True, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(SRC):
        print("上游目录不存在：%s" % SRC)
        return 1

    changed = []
    for rel in FILES:
        src_path = os.path.join(SRC, rel)
        dst_path = os.path.join(DST, rel)
        if not os.path.exists(src_path):
            print("跳过（上游没有）：%s" % rel)
            continue

        with open(src_path, encoding="utf-8") as fh:
            raw = fh.read()
        patched = patch_manifest(raw) if rel == "manifest.json" else patch_text(raw)

        old = ""
        if os.path.exists(dst_path):
            with open(dst_path, encoding="utf-8") as fh:
                old = fh.read()
        if old == patched:
            continue

        changed.append(rel)
        if not args.dry_run:
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            with open(dst_path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(patched)

    if args.dry_run:
        print("将更新 %d 个文件：%s" % (len(changed), ", ".join(changed) or "无"))
        return 0

    problems = []
    for rel in FILES:
        path = os.path.join(DST, rel)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for word in FORBIDDEN:
            if word in text:
                problems.append("%s 仍含「%s」" % (rel, word))
        if rel.endswith(".js"):
            ok, msg = check_js(path)
            if not ok:
                problems.append("%s 语法错误：%s" % (rel, msg))

    print("同步完成，更新 %d 个文件：%s" % (len(changed), ", ".join(changed) or "无变更"))
    if problems:
        print("校验失败：")
        for p in problems:
            print("  - %s" % p)
        return 1
    print("校验通过：无上游品牌残留，JS 语法正常")
    return 0


if __name__ == "__main__":
    sys.exit(main())
