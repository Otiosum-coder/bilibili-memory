# 隐私政策 · Privacy Policy

**哔哩哔哩记忆（Bilibili Memory）**
最后更新：2026-10-25

---

## 一句话总结

**所有数据都保存在你自己的浏览器里。** 本扩展不设服务器、不上传数据、不收集任何个人信息。只有当你**主动配置**自己的 WebDAV 服务器时，数据才会发往**你自己指定的地址**。

---

## 1. 我们收集什么

**我们不收集任何数据。**

本扩展没有后端服务器，没有账号系统，没有统计上报，没有崩溃上报，也没有任何形式的远程日志。开发者无法访问你的任何数据。

扩展读取并保存在**你的浏览器本地 IndexedDB** 中的内容，全部来自你自己的 B 站账号：

| 数据类型 | 用途 | 存放位置 |
| --- | --- | --- |
| 观看历史（视频标题、封面地址、观看时间） | 突破 B 站 3 个月的历史限制 | 本地 |
| 收藏夹与订阅合集内容 | 备份你已收藏/订阅的内容 | 本地 |
| 关注的 UP 主信息（昵称、曾用名、签名、头像地址） | 记录改名 / 取关 / 注销 | 本地 |
| 点赞与投币记录 | 突破 B 站 20 条窗口限制 | 本地 |
| 内容消失时的快照 | 「消失档案」留档与恢复 | 本地 |
| 图片字节（头像、封面） | 内容被删后仍能看到原图 | 本地 |
| B 站登录态（Cookie 中的 SESSDATA） | 调用 B 站官方 API 读取**你自己**的数据 | **仅内存中使用，不落盘、不上传** |

## 2. 我们如何使用这些数据

仅用于扩展自身功能：

- 在你打开扩展界面时展示你的数据
- 按你设定的间隔自动同步最新数据
- 当收藏/关注/点赞的内容消失或账号注销时，用浏览器通知提醒你
- 在你主动点击时，把备份写入你选择的本地目录或你配置的 WebDAV 服务器

**不会**用于：广告、用户画像、数据分析、训练模型、出售或与任何第三方共享。

## 3. 数据会离开你的设备吗

**默认不会。** 只有以下两种情况会：

| 情况 | 数据去向 | 触发方式 |
| --- | --- | --- |
| 你配置了 **WebDAV 同步** | **你自己填写的服务器地址**（如坚果云、自建 NAS） | 手动或按间隔自动同步 |
| 你点击 **导出 / 本地目录备份** | 你选择的本地文件夹 | 手动或按间隔自动备份 |
| 你在「关注列表」里查询**曾用名**（默认关闭，需你先开启并确认） | 第三方站点 `api.aicu.cc` | 仅在你点击查询时，逐条发送该关注用户的 UID |

前两种都是**你自己主动配置**的，服务器地址完全由你决定。开发者不参与、也无法访问。

第三种是**唯一会把数据发往第三方站点**的功能：开启前会明确告知，查询时只发送「你在关注列表里主动查询的那个用户的 UID」，不发送你的账号、Cookie、历史或其他数据；查询频率被限制（逐条间隔发送、可随时停止），结果只保存在本机。

B 站 API 调用：扩展会直接请求 `api.bilibili.com` 等 B 站官方域名，携带你自己的登录态。这是读取你自己数据的唯一途径，与你在浏览器里正常使用 B 站相同。

## 4. 权限用途说明

| 权限 | 为什么需要 |
| --- | --- |
| `storage` / `unlimitedStorage` | 在本地保存上述数据；`unlimitedStorage` 用于图片字节归档，可能超过普通配额 |
| `cookies` | 读取**你自己**的 B 站登录态以调用官方 API。仅在本机内存使用，不上传 |
| `alarms` | 定时触发数据同步与图片归档 |
| `notifications` | 内容消失、账号注销时提醒你 |
| `tabs` | 打开扩展主界面与 B 站视频页 |
| `declarativeNetRequest` | 改写 Referer 头，让 B 站图片能在扩展页面正常显示（B 站有防盗链） |
| `<all_urls>` | 你的 WebDAV 服务器地址无法预先确定，需要在运行时按你填写的地址访问 |

**不含任何远程代码**：所有 JavaScript 都打包在扩展内部，不加载、不执行任何外部脚本。

## 5. 数据删除

你有完全的控制权：

- **删除单条数据**：在对应页面操作
- **清空全部数据**：设置页 → 重置扩展
- **彻底移除**：在浏览器中删除本扩展，其 IndexedDB 数据会一并被浏览器清除

由于开发者不持有你的任何数据，**无需向开发者申请删除**。

## 6. 儿童隐私

本扩展不面向 13 岁以下儿童，也不收集任何用户信息。

## 7. 第三方

本扩展**不集成**任何第三方 SDK、广告库、统计服务或分析工具。

可选功能会访问以下第三方站点，均为你主动触发：

- `api.bilibili.com` 等 B 站官方接口 —— 读取你自己的数据
- `biliplus.com` / `jijidown.com` —— **仅在你点击「恢复失效内容」时**查询公开的视频存档信息
- `api.aicu.cc` —— **仅在你开启「曾用名查询」并点击查询时**，发送该关注用户的 UID 以查询公开的曾用名存档。该站点由第三方维护，可能随时失效
- 你自建的 WebDAV 服务器

## 8. 政策变更

本政策如有更新，会同步修改本文件与「最后更新」日期，并随扩展版本一起发布。

## 9. 联系方式

- GitHub Issues：<https://github.com/Otiosum-coder/bilibili-memory/issues>
- 仓库主页：<https://github.com/Otiosum-coder/bilibili-memory>

---

## English Summary

**Bilibili Memory** is a browser extension that saves **your own** Bilibili data (watch history, favorites, followed creators, likes/coins) locally in your browser's IndexedDB.

- **We do not collect any data.** There is no backend server, no analytics, no telemetry, no account system. The developer cannot access your data.
- Your Bilibili session cookie (`SESSDATA`) is used **in memory only** to call Bilibili's official APIs on your behalf. It is never stored or transmitted to the developer.
- Data leaves your device **only** when you configure your own WebDAV server or export a backup to a local folder — both are user-initiated and go only where you choose.
- **One optional exception:** if you enable "look up former names" (off by default, needs explicit confirmation), the UID of the followed user you choose to look up is sent to `api.aicu.cc` — a third-party archive site. No account, cookie, history or other data is sent, requests are rate-limited, and you can stop at any time.
- **No remote code.** All scripts are bundled within the extension.
- To remove all data, uninstall the extension from your browser.

Third-party endpoints contacted (only on user action): `api.bilibili.com` (Bilibili's official API), `biliplus.com` / `jijidown.com` (public archives, only when you click "recover invalid content"), `api.aicu.cc` (public former-name archive, only when you enable the feature and click a lookup), and your own WebDAV server.

Contact: <https://github.com/Otiosum-coder/bilibili-memory/issues>
