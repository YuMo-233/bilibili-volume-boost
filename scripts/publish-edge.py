#!/usr/bin/env python3
"""通过 Edge 加载项「发布 API」上传扩展包并提交审核。

把发版从「打开 Partner Center、点替换、在系统文件对话框里选文件、点发布」
压缩成两条命令，适合之后接 CI 或定时任务。

用法：
    python scripts/publish-edge.py status
    python scripts/publish-edge.py upload [zip路径]
    python scripts/publish-edge.py publish --notes-file 说明.txt
    python scripts/publish-edge.py watch <operationId> --kind package|submission

凭据（**绝不进版本库**）按以下优先级读取：
  1. 环境变量 EDGE_PUBLISH_CLIENT_ID / EDGE_PUBLISH_API_KEY / EDGE_PUBLISH_PRODUCT_ID
  2. 仓库外的 JSON 文件，默认 <repo>/../dist/edge-store/credentials.json
     （可用环境变量 EDGE_PUBLISH_CRED 指定其他路径）

凭据文件格式：{"clientId": "...", "apiKey": "...", "productId": "..."}

安全约定：本脚本任何情况下都不打印完整密钥，只显示掩码。

API 限制（官方文档明确说明）：没有更新产品元数据的端点——名称、简介、详细说明
仍须在 Partner Center 页面改。本脚本只负责「传包」与「提交审核」。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://api.addons.microsoftedge.microsoft.com"

DEFAULT_CRED = os.path.normpath(os.path.join(REPO, "..", "dist", "edge-store", "credentials.json"))
DEFAULT_PKG_DIR = os.path.normpath(os.path.join(REPO, "..", "dist", "edge-store"))

TERMINAL_OK = {"succeeded", "completed", "success"}
TERMINAL_BAD = {"failed", "error", "cancelled", "canceled"}


def mask(s):
    if not s:
        return "(空)"
    if len(s) <= 8:
        return s[:2] + "*" * (len(s) - 2)
    return f"{s[:4]}{'*' * 8}{s[-4:]} (长度 {len(s)})"


def load_cred():
    path = os.environ.get("EDGE_PUBLISH_CRED") or DEFAULT_CRED
    data = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        print(f"[提示] 未找到凭据文件：{path}")
        print("       可改用环境变量 EDGE_PUBLISH_CLIENT_ID / EDGE_PUBLISH_API_KEY。")

    cred = {
        "clientId": os.environ.get("EDGE_PUBLISH_CLIENT_ID") or data.get("clientId"),
        "apiKey": os.environ.get("EDGE_PUBLISH_API_KEY") or data.get("apiKey"),
        "productId": os.environ.get("EDGE_PUBLISH_PRODUCT_ID") or data.get("productId"),
        "expiresAt": data.get("expiresAt"),
        "keyName": data.get("keyName"),
        "source": path if os.path.isfile(path) else "(环境变量)",
    }
    missing = [k for k in ("clientId", "apiKey", "productId") if not cred[k]]
    if missing:
        raise SystemExit(f"缺少凭据字段：{', '.join(missing)}")
    return cred


def request(cred, method, path, body=None, content_type=None, timeout=60):
    url = BASE + path
    headers = {
        "Authorization": "ApiKey " + cred["apiKey"],
        "X-ClientID": cred["clientId"],
    }
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()
    except Exception as e:
        return 0, {}, repr(e).encode()


def op_id_from(hdrs):
    """从 Location 响应头解析 operationId（绝对 URL 的最后一段）。"""
    loc = ""
    for k, v in hdrs.items():
        if k.lower() == "location":
            loc = v
            break
    if not loc:
        return None
    return loc.rstrip("/").rsplit("/", 1)[-1]


def show(status, hdrs, body):
    text = body.decode("utf-8", "replace").strip()
    print(f"  HTTP {status}")
    if text:
        try:
            print("  " + json.dumps(json.loads(text), ensure_ascii=False, indent=2).replace("\n", "\n  "))
        except Exception:
            print("  " + text[:800])
    op = op_id_from(hdrs)
    if op:
        print(f"  operationId: {op}")
    return op


def watch(cred, kind, opid, interval=5, timeout=900):
    if kind == "package":
        path = f"/v1/products/{cred['productId']}/submissions/draft/package/operations/{opid}"
    else:
        path = f"/v1/products/{cred['productId']}/submissions/operations/{opid}"

    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        st, _, body = request(cred, "GET", path)
        text = body.decode("utf-8", "replace")
        try:
            data = json.loads(text)
        except Exception:
            data = {}
        state = str(data.get("status") or data.get("state") or "").strip().lower()
        if state != last:
            print(f"  [{time.strftime('%H:%M:%S')}] {state or '(无 status 字段)'}  {text[:300]}")
            last = state
        if state in TERMINAL_OK:
            return True
        if state in TERMINAL_BAD:
            return False
        if st >= 400:
            print(f"  轮询失败：HTTP {st} {text[:300]}")
            return False
        time.sleep(interval)
    print("  轮询超时，请稍后手动复查。")
    return False


def default_zip():
    manifest = json.load(open(os.path.join(REPO, "manifest.json"), encoding="utf-8"))
    return os.path.join(DEFAULT_PKG_DIR, f"bili-volume-boost-{manifest['version']}.zip")


def cmd_status(cred):
    print("凭据来源   ", cred["source"])
    print("Client ID  ", cred["clientId"])
    print("API Key    ", mask(cred["apiKey"]))
    print("Product ID ", cred["productId"])
    if cred.get("keyName"):
        print("密钥名称   ", cred["keyName"], f"（到期 {cred.get('expiresAt') or '未知'}）")
    expected = default_zip()
    print("默认程序包 ", expected, "✓ 存在" if os.path.isfile(expected) else "✗ 不存在")


def clipboard_text():
    """读取 Windows 剪贴板，避免密钥经由对话或 shell 历史传递。"""
    import subprocess

    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
        capture_output=True,
        text=True,
    )
    return (r.stdout or "").strip()


def cmd_init(client_id, api_key, path, from_clipboard):
    if from_clipboard:
        api_key = clipboard_text()
        print(f"已从剪贴板读取密钥，长度 {len(api_key)}")
    if not api_key:
        raise SystemExit("没有拿到 API 密钥。请先在 Partner Center 复制密钥，或改用 --api-key 传入。")
    if not (20 <= len(api_key) <= 80) or any(ord(ch) < 33 or ord(ch) > 126 for ch in api_key):
        raise SystemExit(f"密钥格式可疑（长度 {len(api_key)}，要求可打印 ASCII 且无空格），已中止写入。")
    if not client_id:
        raise SystemExit("缺少 --client-id。每次重建凭据 Client ID 都会变，必须一起更新。")

    data = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    data.update(
        {
            "clientId": client_id,
            "apiKey": api_key,
            "productId": data.get("productId") or "8d677011-d896-47eb-90a9-34b058d00fed",
            "keyName": data.get("keyName") or "",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
            "expiresAt": data.get("expiresAt") or "",
        }
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"已写入 {path}")
    print(f"  Client ID {data['clientId']}")
    print(f"  API Key   {mask(api_key)}")
    print("提示：Edge 密钥有效期仅 72 天，到期前需回 Partner Center 重建（会同时换掉 Client ID）。")


def cmd_upload(cred, zip_path):
    if not os.path.isfile(zip_path):
        raise SystemExit(f"找不到程序包：{zip_path}")
    raw = open(zip_path, "rb").read()
    print(f"上传 {zip_path}")
    print(f"  大小 {len(raw):,} 字节")
    st, hdrs, body = request(
        cred,
        "POST",
        f"/v1/products/{cred['productId']}/submissions/draft/package",
        body=raw,
        content_type="application/zip",
        timeout=300,
    )
    op = show(st, hdrs, body)
    if st not in (200, 201, 202):
        raise SystemExit("上传请求未被接受。")
    if not op:
        raise SystemExit("响应中没有 operationId，无法确认上传结果。")
    print("等待上传处理…")
    ok = watch(cred, "package", op)
    print("上传成功。" if ok else "上传未成功，请检查上方状态。")


def cmd_publish(cred, notes, interval, timeout):
    payload = json.dumps({"notes": notes}, ensure_ascii=False).encode("utf-8")
    print(f"提交审核，认证说明 {len(notes)} 字")
    st, hdrs, body = request(
        cred,
        "POST",
        f"/v1/products/{cred['productId']}/submissions",
        body=payload,
        content_type="application/json",
    )
    op = show(st, hdrs, body)
    if st not in (200, 201, 202):
        raise SystemExit("发布请求未被接受。")
    if not op:
        raise SystemExit("响应中没有 operationId，无法确认提交结果。")
    print("等待提交流程…")
    ok = watch(cred, "submission", op, interval=interval, timeout=timeout)
    print("已提交，等待微软审核。" if ok else "提交未完成，请检查上方状态。")


def cmd_watch(cred, kind, opid, interval, timeout):
    ok = watch(cred, kind, opid, interval=interval, timeout=timeout)
    print("完成。" if ok else "未完成或失败。")


def main():
    ap = argparse.ArgumentParser(description="Edge 加载项发布 API 助手")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="检查凭据与默认程序包")

    p_init = sub.add_parser("init", help="写入/更新 API 凭据（密钥可从剪贴板读取）")
    p_init.add_argument("--client-id", required=True, help="Partner Center 发布 API 页显示的客户端 ID")
    p_init.add_argument("--api-key", help="API 密钥；留空则配合 --from-clipboard")
    p_init.add_argument("--from-clipboard", action="store_true", help="从剪贴板读取密钥，避免明文出现在命令里")
    p_init.add_argument("--cred", help="凭据文件路径，默认仓库外的 dist/edge-store/credentials.json")

    p_up = sub.add_parser("upload", help="上传程序包到草稿")
    p_up.add_argument("zip", nargs="?", help="程序包路径，默认取 dist 中与 manifest 版本匹配的 zip")

    p_pub = sub.add_parser("publish", help="提交审核")
    g = p_pub.add_mutually_exclusive_group(required=True)
    g.add_argument("--notes", help="认证说明正文")
    g.add_argument("--notes-file", help="认证说明文本文件（UTF-8）")
    p_pub.add_argument("--interval", type=int, default=10)
    p_pub.add_argument("--timeout", type=int, default=1800)

    p_w = sub.add_parser("watch", help="轮询某个操作")
    p_w.add_argument("opid")
    p_w.add_argument("--kind", choices=["package", "submission"], default="package")
    p_w.add_argument("--interval", type=int, default=5)
    p_w.add_argument("--timeout", type=int, default=900)

    args = ap.parse_args()
    if args.cmd == "init":
        cmd_init(args.client_id, args.api_key, args.cred or DEFAULT_CRED, args.from_clipboard)
        return
    cred = load_cred()

    if args.cmd == "status":
        cmd_status(cred)
    elif args.cmd == "upload":
        cmd_upload(cred, args.zip or default_zip())
    elif args.cmd == "publish":
        notes = args.notes
        if args.notes_file:
            notes = open(args.notes_file, encoding="utf-8").read().strip()
        if not notes:
            raise SystemExit("认证说明不能为空（Partner Center 会因此禁用发布按钮）。")
        cmd_publish(cred, notes, args.interval, args.timeout)
    elif args.cmd == "watch":
        cmd_watch(cred, args.kind, args.opid, args.interval, args.timeout)


if __name__ == "__main__":
    main()
