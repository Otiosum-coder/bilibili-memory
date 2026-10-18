# 迁移旧扩展数据到固定 ID

## 背景

Chrome 为**未打包扩展**分配的 ID，是由扩展**绝对路径**的 SHA256 算出来的。
所以把项目文件夹改名（`bilibili-history-wxt` → `bilibili-memory`）会得到一个新的扩展 ID，
而 IndexedDB 与 `chrome.storage.local` 都是**按扩展 ID 隔离**的 —— 于是新扩展看到的是空数据。

**旧数据没有丢**，它还在旧 ID 的目录下，只是新扩展读不到。

现在 `wxt.config.ts` 里加了固定的 `manifest.key`，扩展 ID 恒定为：

```
baadkghamjpcngkgcjfhjoniflnakple
```

以后无论文件夹叫什么、装在哪台机器上，ID 都不再变化。

## 迁移步骤

### 0. 完全退出 Chrome

任务管理器里确认没有 `chrome.exe` 残留（托盘图标也要退出）。
LevelDB 文件在 Chrome 运行时是锁定状态，复制会失败或损坏。

### 1. 在 Chrome 里重新加载扩展

重新打开 Chrome → `chrome://extensions/` → 找到扩展 → 点「重新加载」。
因为 manifest 带了 `key`，此时它会以**固定 ID** 出现：

```
baadkghamjpcngkgcjfhjoniflnakple
```

（原来的 `odlepj...` 会消失或变成错误卡片，其数据也可以一并迁过来，见步骤 4。）

**再退出 Chrome。**

### 2. 备份两边的现有数据（防出错）

```powershell
$base = 'C:\Users\Nameless\AppData\Local\Google\Chrome\User Data\Default'
$bk   = 'E:\Project\bilibiliMemory\.extension-key\data-backup'
New-Item -ItemType Directory -Force -Path $bk | Out-Null

# 旧的（有完整数据）
Copy-Item "$base\IndexedDB\chrome-extension_gdnigbmjcjkldciajkjgeoibmimlionh_0.indexeddb.leveldb" "$bk\old.leveldb" -Recurse -Force
Copy-Item "$base\IndexedDB\chrome-extension_gdnigbmjcjkldciajkjgeoibmimlionh_0.indexeddb.blob"    "$bk\old.blob"    -Recurse -Force
Copy-Item "$base\Local Extension Settings\gdnigbmjcjkldciajkjgeoibmimlionh" "$bk\old-storage" -Recurse -Force
```

### 3. 建立目标 ID 的目录

`baadkghamjpcngkgcjfhjoniflnakple` 这个 ID 下**还不存在**数据目录（第一次用 key 启动后才会创建）。
所以先**启动一次 Chrome 打开扩展**（让它建出空目录），再退出 Chrome，然后执行复制。

确认目录已存在：

```powershell
Test-Path "$base\IndexedDB\chrome-extension_baadkghamjpcngkgcjfhjoniflnakple_0.indexeddb.leveldb"
```

### 4. 复制数据

**Chrome 必须处于关闭状态。**

```powershell
$base = 'C:\Users\Nameless\AppData\Local\Google\Chrome\User Data\Default'
$OLD  = 'gdnigbmjcjkldciajkjgeoibmimlionh'
$NEW  = 'baadkghamjpcngkgcjfhjoniflnakple'

foreach ($suffix in @('indexeddb.leveldb','indexeddb.blob')) {
  $src = "$base\IndexedDB\chrome-extension_${OLD}_0.$suffix"
  $dst = "$base\IndexedDB\chrome-extension_${NEW}_0.$suffix"
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
}

# chrome.storage.local（设置、WebDAV 凭据、同步水位等）
$srcLs = "$base\Local Extension Settings\$OLD"
$dstLs = "$base\Local Extension Settings\$NEW"
if (Test-Path $dstLs) { Remove-Item $dstLs -Recurse -Force }
Copy-Item $srcLs $dstLs -Recurse -Force
```

### 5. 启动 Chrome 验证

打开扩展 → 总览页应能看到旧的历史记录条数、收藏夹、关注列表、消失档案、图片归档。

## 如果迁移失败（备用方案）

不动 LevelDB，改用扩展自己的导出/导入：

1. 退出 Chrome
2. 把文件夹临时改回 `bilibili-history-wxt`
3. 打开 Chrome → 旧扩展 ID 复活，旧数据全部可见（新代码会把 DB 从 v10 自动升到 v11）
4. 数据备份 → 导出 JSON（全选）
5. 退出 Chrome，文件夹改回 `bilibili-memory`
6. 打开 Chrome → 导入刚才的 JSON

**注意**：JSON 导入**不含图片字节**，头像/封面会丢失，只能靠「本地目录备份」的 `images/` 恢复。

## 为什么优先用直接复制

`E:\Nameless\Documents\BackUp` 里最近的备份是 `2026-10-11`，
而旧扩展的数据一直到 `2026-10-17`。用备份会丢掉 6 天的数据，
直接复制 IndexedDB 能把**记录 + 75MB 图片字节**完整搬过来。

## 私钥

固定 ID 对应的私钥在 `E:\Project\bilibiliMemory\.extension-key\private-key.pem`
（在仓库目录之外，不会被提交）。

上架 Chrome Web Store 或签名 `.crx` 时需要它。**务必备份到密码管理器**，丢失后无法再用同一 ID 发布更新。
