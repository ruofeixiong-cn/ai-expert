import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// 复用 vite 的别名与插件，测试里的 `@/` 和线上一致
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
    },
  }),
);
