import { defineConfig } from "wxt";

// 商店包（wxt zip）里**不能**带写死的 `key`：
// Chrome Web Store 会用商店条目自己的公钥校验，包里带一个不同的 key 会直接报
// 「清单中 "key" 字段的值与当前内容不符」。0.3.1 的商店包同样没有 key。
// 只在开发/普通构建里保留 key，保证本地自用扩展 ID 恒定（baadkghamjpcngkgcjfhjoniflnakple）。
const IS_STORE_PACKAGE =
  process.argv.includes("zip") || process.env.npm_lifecycle_event === "zip";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => ({
    // 写死公钥后，未打包扩展的 ID 恒定，与路径、机器无关（数据不会"看似丢失"）。
    // 注意：商店打包（zip）会自动省略这个字段，见上方 IS_STORE_PACKAGE。
    ...(IS_STORE_PACKAGE
      ? {}
      : {
          key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu111GTqYb7XKFWcDaAloxx4EN6SMHdJ6zijaLwBBioSSUdGUI893iQg8ShYYaoX51bPe2rC9iGU6yvLqaJblEqE1fsNHSRSk0TE1z7qeLXl4qD9+nRND2dE7XrxTlwkd3Jp7/uqhGyErzMe/0MeLba3xuF52U/1WOU3t4Mzks+twcKUFGYsd7aQlrUc+BadN3Wgnr3rwbYnBngW6K5XPWBoyH4ybUqGUj/1m1RcBoEjoLhVPkGs4Pytp9RIyODLU/tCJiYW+4yfq/EBHXvd12qeiMR2lRQ08Wh2CRyJO3ApkIY/HNc/bxSIS+A4lALTqzuTB5+qXSmE0tWaxXKBHlwIDAQAB",
        }),
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
          // AMO 自 2025-11-03 起强制要求：新提交的扩展必须声明收集/传输哪些数据。
          // 缺这个字段，上传时会直接报
          //   The "data_collection_permissions" property is missing.
          //
          // 本版取值说明（v0.4.0）：
          // - required: ["none"] —— 扩展默认不向任何服务器传输数据，所有内容只写进本机；
          // - optional: ["personallyIdentifyingInfo"] —— 「关注列表曾用名查询」由用户在设置页
          //   显式开启并同意后才可用，查询时会把**关注用户的 UID**（个人标识符）发送到
          //   第三方档案 api.aicu.cc。它是可选项，因此放在 optional，而不是 required。
          // WebDAV 同步仍是用户自己填地址、主动触发的导出，不计入这里。
          // 提交 AMO 时需在隐私说明中同步披露该可选传输行为。
          data_collection_permissions: {
            required: ["none"],
            optional: ["personallyIdentifyingInfo"],
          },
        },
      },
    }),
  }),
});
