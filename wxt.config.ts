import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => ({
    // 固定的扩展 ID = `baadkghamjpcngkgcjfhjoniflnakple`
    //
    // 为什么需要它：未打包扩展的 ID 由**绝对路径**的 SHA256 算出，于是"换个文件夹名"
    // 就会变成另一个扩展——IndexedDB 与 storage.local 全部按 ID 隔离，看起来像数据丢了。
    // 写死公钥后 ID 恒定，与路径、机器都无关。
    //
    // 私钥不要提交（只有上架商店签名才需要），请另行离线备份。
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu111GTqYb7XKFWcDaAloxx4EN6SMHdJ6zijaLwBBioSSUdGUI893iQg8ShYYaoX51bPe2rC9iGU6yvLqaJblEqE1fsNHSRSk0TE1z7qeLXl4qD9+nRND2dE7XrxTlwkd3Jp7/uqhGyErzMe/0MeLba3xuF52U/1WOU3t4Mzks+twcKUFGYsd7aQlrUc+BadN3Wgnr3rwbYnBngW6K5XPWBoyH4ybUqGUj/1m1RcBoEjoLhVPkGs4Pytp9RIyODLU/tCJiYW+4yfq/EBHXvd12qeiMR2lRQ08Wh2CRyJO3ApkIY/HNc/bxSIS+A4lALTqzuTB5+qXSmE0tWaxXKBHlwIDAQAB",
    name: "Bilibili Memory",
    description:
      "本地永久保存 B 站观看历史、收藏夹、订阅合集、关注列表与点赞/投币记录；内容被删除、下架或账号注销后仍可追溯，并可随时恢复到原页面。",
    permissions: [
      "unlimitedStorage",
      "storage",
      "tabs",
      "cookies",
      "alarms",
      "notifications",
      "declarativeNetRequest",
    ],
    declarative_net_request: {
      rule_resources: [
        {
          id: "referrer-bilibili",
          enabled: true,
          path: "referrer.json",
        },
      ],
    },
    host_permissions: ["<all_urls>"],
    web_accessible_resources: [
      {
        resources: ["injected.js"],
        matches: ["*://*.bilibili.com/*"],
      },
    ],
    action: {},

    // Firefox 专用：AMO 要求扩展有固定的 gecko id，否则无法稳定签名与后续更新。
    //
    // 只在 firefox 目标注入，否则 Chrome 包里会多出一个无用的键。
    // strict_min_version 定在 128 的原因：
    //   - `declarative_net_request` 在 Firefox 的 Manifest V2 下可用（MDN 标注 "Manifest 版本 2 或更高"）
    //   - 但 MDN 明确写了：**Firefox 128 之前，含未知属性的 DNR 规则会被判定无效且整条不加载**；
    //     128 起改为「忽略未知属性、其余照常生效」。我们的规则集来自上游、字段较多，
    //     定在 128 可以避免低版本下整份规则集静默失效
    //   - 128 是 2024 年 7 月的 ESR，覆盖率足够
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "bilibili-memory@otiosum-coder",
          strict_min_version: "128.0",
        },
      },
    }),
  }),
});
