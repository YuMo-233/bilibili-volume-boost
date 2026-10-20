# 用发布 API 发版（免手动上传）

**结论：上传程序包和提交审核都能自动化，`scripts/publish-edge.py` 已经跑通；但产品元数据（名称、简介、详细说明、截图）没有 REST 端点，仍须在 Partner Center 页面改。**

这条链路替代的正是过去卡住的两处人工动作：点「替换」、在操作系统文件对话框里选文件，以及点「发布」。直连网关，不经过浏览器，也就绕开了 Web Components + shadow DOM 那层读不到表单的麻烦。

---

## 1. 能力边界

| 动作 | API 能否完成 | 说明 |
| --- | --- | --- |
| 上传程序包到草稿 | ✅ | `POST /v1/products/{productId}/submissions/draft/package` |
| 查询上传校验结果 | ✅ | 校验失败会藏在 HTTP 200 的 JSON 里，必须轮询 |
| 提交审核（发布） | ✅ | `POST /v1/products/{productId}/submissions`，body `{"notes": "..."}` |
| 查询提交状态 | ✅ | `GET .../submissions/operations/{operationId}` |
| 改名称 / 简介 / 详细说明 / 截图 / 搜索词 | ❌ | 官方明确「没有更新产品元数据的端点」，只能进 Partner Center |
| 首次创建产品 | ❌ | 同上，首个版本必须走 Partner Center |

网关：`https://api.addons.microsoftedge.microsoft.com`，认证用 v1.1 的 API Key（v1 的 access token 方式已于 2024-12-31 停用）。

---

## 2. 一次性准备：拿凭据

Partner Center → **Microsoft Edge** → **发布 API** → 「新建 API 凭据」/「创建 API 凭据」。

生成两样东西：

- **客户端 ID**（GUID，形如 `xxxxxxxx-xxxx-...`）
- **API 密钥**（长串可打印 ASCII，含 `#` `!` 等符号）

> ⚠️ **密钥只在创建时完整显示一次**，之后页面上只剩 `XGT•••••` 掩码。当场复制，否则只能重建。

拿到后写入仓库外的凭据文件（**密钥不进对话、不进 shell 历史**）：

```bash
# 1) 先在 Partner Center 点密钥旁的复制按钮
# 2) 再执行（--from-clipboard 从剪贴板取，命令行里不出现明文）
python scripts/publish-edge.py init \
  --client-id <客户端ID> \
  --from-clipboard
```

写到 `../dist/edge-store/credentials.json`，也可以 `--cred <路径>` 指定别处，或用环境变量 `EDGE_PUBLISH_CLIENT_ID` / `EDGE_PUBLISH_API_KEY` / `EDGE_PUBLISH_PRODUCT_ID` 覆盖。

---

## 3. 两个必须记住的坑

### 3.1 有效期只有 72 天，且重建会连带换掉 Client ID

微软把 Edge 加载项 API 密钥的有效期缩短到了 **72 天**，不能用 API 续期，也不能延长——上限就是 72 天，到期必须回页面重建。

**最坑的一点：重建凭据时，Client ID 会一起变。** 如果只更新密钥、忘了更新 Client ID，请求会被拒，报错是 `403 Client ID is Invalid`，看起来完全不像"过期"。

观察到的实例：2026-10-20 22:34 创建的凭据（Client ID `197d8214…`）在 22:35 被重建一次后立即作废，换成 Client ID `7ed8717d…`。**所以两者必须成对更新**——`init` 命令强制要求 `--client-id` 就是这个原因。

到期时间在 `status` 里能看到；建议在日历上提前一周设提醒，别等发版当天才发现。

### 3.2 校验失败不会返回错误码

上传请求返回 `202 Accepted` 只代表"收到了"。包是否合法要看轮询结果：**校验失败时 HTTP 状态仍是 200，失败原因在 JSON 里**。所以脚本一定会轮询到底，不会传完就报成功。

另一个 Edge 独有的限制：**包内不允许出现压缩文件**（校验器读魔数，改名没用）。本项目的 `pack-store.py` 只打纯 JS/PNG/JSON，不受影响。

---

## 4. 发版流程

```bash
# 0) 改完代码记得先递增 manifest.json 的 version，否则商店拒收
python scripts/pack-store.py          # 打包，打印字节数与 sha256

# 1) 确认凭据和包
python scripts/publish-edge.py status

# 2) 上传到草稿（会自动轮询校验结果）——到这一步商店仍是线上旧版
python scripts/publish-edge.py upload

# 3) 写认证说明（测试指引 + 本次更新说明，见 edge-submission.md §6 / §8.1）
#    存成 UTF-8 文本文件后提交审核
python scripts/publish-edge.py publish --notes-file notes.txt
```

上传和发布是分开的：`upload` 只更新草稿，**不会让新版上线**；`publish` 才把草稿提交给微软审核，且不可撤回。想在发布前再核对一遍，就停在第 2 步，去 Partner Center 看草稿。

---

## 5. 排错对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `403 Client ID is Invalid` | 密钥与 Client ID 不是同一次生成的 | 成对重取，跑 `init` |
| `403` 且无 body | 同上；也见于密钥过期 | 同上 |
| `404 Resource not found` | 端点写错 / 商品 ID 用错 | 商品 ID 取 Partner Center URL 里 `microsoftedge/` 与 `/packages` 之间的 GUID |
| `202` 但轮询 `Failed` | 包内容不合法（含压缩文件、manifest 错、图标尺寸不符） | 看轮询返回的 message，逐条修 |
| 发布时提示认证说明为空 | `notes` 必填 | 传 `--notes` 或 `--notes-file` |

---

## 6. 安全约定

- 凭据只存在**仓库外**的 `../dist/edge-store/credentials.json`；仓库 `.gitignore` 已加防御性规则（`credentials.json`、`*.key`、`.env` 等）。
- 脚本任何输出都不打印完整密钥，只给 `前4****后4 (长度)` 掩码。
- 密钥一旦怀疑泄露（截图、粘贴到聊天、提交进仓库），立即回 Partner Center 重建；重建后 Client ID 也一并更新。
- 若密钥曾被提交进 git 历史，仅删文件无效——历史里仍可翻出，必须重建密钥。

---

## 7. 与人工流程的分工

| 步骤 | 谁来做 |
| --- | --- |
| 递增版本号、打包、校验包内文件与源码一致 | 脚本 / 本仓库 |
| 上传程序包、提交审核、盯状态 | **API（本脚本）** |
| 改详细说明、搜索词、截图、类别等元数据 | 人工（Partner Center） |
| 确认商店一览的语言项是否变为「中文（简体）」 | 人工看一眼（由包内 i18n 推断，页面改不了） |
| 重建到期密钥 | 人工（每 72 天） |
