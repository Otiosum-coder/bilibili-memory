import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Bilibili Memory",
    description:
      "本地永久保存 B 站观看历史、收藏夹、关注列表与点赞/投币记录，防止内容消失后无从追溯。",
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
  },
});
