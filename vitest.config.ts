import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只覆盖纯函数模块；不加载 DOM，也不 mock IndexedDB
    include: ["utils/**/*.test.ts", "components/**/*.test.ts", "pages/**/*.test.ts"],
    environment: "node",
  },
});
