#!/usr/bin/env python
"""把 extension/ 打成可安装/可归档的 zip，并在打包前做引用自检。

检查项：
  1. manifest 里引用的文件（service_worker / content_scripts / options / icons）都存在
  2. options.html 里 <script src> / <link href> 指向的文件都存在
  3. 每个 .js 过一遍 node --check
  4. manifest 版本与 sync_extension.py 的 VERSION 一致，避免发出去的包版本对不上

    python scripts/package_extension.py
    python scripts/package_extension.py --out D:/somewhere
"""

import argparse
import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")
NODE = os.environ.get("DLDB_NODE", r"D:\nodejs\node.exe")


def referenced_files(manifest):
    files = set()
    bg = (manifest.get("background") or {}).get("service_worker")
    if bg:
        files.add(bg)
    for cs in manifest.get("content_scripts", []):
        files.update(cs.get("js") or [])
        files.update(cs.get("css") or [])
    page = (manifest.get("options_ui") or {}).get("page")
    if page:
        files.add(page)
    for _, path in (manifest.get("icons") or {}).items():
        files.add(path)
    for _, path in ((manifest.get("action") or {}).get("default_icon") or {}).items():
        files.add(path)
    files.add("manifest.json")
    return files


def html_assets(path):
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    found = set()
    for match in re.finditer(r'(?:src|href)="([^"#?]+)"', text):
        ref = match.group(1)
        if ref.startswith(("http:", "https:", "//", "data:")):
            continue
        found.add(ref.lstrip("./"))
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    args = ap.parse_args()

    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    version = manifest["version"]

    wanted = referenced_files(manifest)
    for rel in list(wanted):
        if rel.endswith(".html"):
            wanted.update(html_assets(os.path.join(SRC, rel)))

    missing = sorted(r for r in wanted if not os.path.exists(os.path.join(SRC, r)))
    if missing:
        print("打包失败：manifest 引用了不存在的文件")
        for rel in missing:
            print("  - %s" % rel)
        return 1

    broken = []
    for rel in sorted(wanted):
        if not rel.endswith(".js"):
            continue
        if not os.path.exists(NODE):
            break
        proc = subprocess.run(
            [NODE, "--check", os.path.join(SRC, rel)], capture_output=True, text=True
        )
        if proc.returncode != 0:
            broken.append((rel, (proc.stderr or "").strip().splitlines()[:2]))
    if broken:
        print("打包失败：JS 语法错误")
        for rel, msg in broken:
            print("  - %s %s" % (rel, msg))
        return 1

    os.makedirs(args.out, exist_ok=True)
    target = os.path.join(args.out, "dlsite-coupon-plus-%s.zip" % version)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(wanted):
            zf.write(os.path.join(SRC, rel), rel)

    size = os.path.getsize(target)
    print("打包完成 v%s" % version)
    print("  产物 %s（%.1f KB，%d 个文件）" % (target, size / 1024, len(wanted)))
    for rel in sorted(wanted):
        print("  · %s" % rel)
    return 0


if __name__ == "__main__":
    sys.exit(main())
