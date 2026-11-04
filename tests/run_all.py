"""统一测试入口：python tests/run_all.py

跑两类测试：
  1. Python（站点 + 图表 + 接口）
  2. Node（油猴 shim 与构建产物），找不到 node 时跳过
"""

import os
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

loader = unittest.TestLoader()
suite = loader.discover(start_dir=ROOT, pattern="test_*.py")
result = unittest.TextTestRunner(verbosity=2).run(suite)

ok = result.wasSuccessful()

node = os.environ.get("DLDB_NODE") or shutil.which("node") or r"D:\nodejs\node.exe"
if os.path.exists(node):
    print("\n---- 油猴脚本测试 ----")
    proc = subprocess.run([node, os.path.join(ROOT, "test_userscript.mjs")])
    ok = ok and proc.returncode == 0
else:
    print("\n未找到 node，跳过油猴测试")

sys.exit(0 if ok else 1)
