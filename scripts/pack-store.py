#!/usr/bin/env python3
"""打包 Edge 加载项上架用的 zip。

用法：
    python scripts/pack-store.py [输出目录]

输出目录默认是仓库外的 d:/app/dist/edge-store/，文件名为 bili-volume-boost-<version>.zip，
version 取自 manifest.json。

打包规则（与历史已上架版本保持一致）：
  · zip 内只有运行所需文件，且**不带顶层目录**（解压后 manifest.json 应直接位于根）
  · 允许的顶层条目：manifest.json、content/、popup/、icons/、_locales/
  · docs/、README.md、LICENSE、PRIVACY.md、CONTEXT.md、scripts/、.workbuddy/、素材/ 一律不进包
  · 固定时间戳，保证同样输入产出同样字节（便于核对 sha256）
"""

import hashlib
import json
import os
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED_TOP = ("manifest.json", "content", "popup", "icons", "_locales")
DEFAULT_OUT = r"d:\app\dist\edge-store"
FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def collect():
    entries = []
    for top in ALLOWED_TOP:
        path = os.path.join(REPO, top)
        if not os.path.exists(path):
            raise SystemExit(f"缺少必需条目：{top}")
        if os.path.isfile(path):
            entries.append((top, path))
            continue
        for root, dirs, files in os.walk(path):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(root, name)
                entries.append((os.path.relpath(full, REPO).replace(os.sep, "/"), full))
    return sorted(entries)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    manifest = json.load(open(os.path.join(REPO, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]

    # 版本号必须从 manifest 取，防止包名与包内版本不一致
    if "__MSG_" in manifest["name"]:
        locales = json.load(
            open(os.path.join(REPO, "_locales", manifest["default_locale"], "messages.json"), encoding="utf-8")
        )
        name = locales[manifest["name"].strip("_").replace("MSG_", "", 1)]["message"]
    else:
        name = manifest["name"]

    entries = collect()
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"bili-volume-boost-{version}.zip")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arcname, full in entries:
            info = zipfile.ZipInfo(arcname, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as fh:
                zf.writestr(info, fh.read())

    raw = open(out, "rb").read()
    print(f"输出      {out}")
    print(f"版本      {version}")
    print(f"名称      {name}")
    print(f"文件数    {len(entries)}")
    print(f"字节数    {len(raw)}")
    print(f"sha256    {hashlib.sha256(raw).hexdigest()}")
    print("清单：")
    for arcname, _ in entries:
        print(f"  {arcname}")


if __name__ == "__main__":
    main()
