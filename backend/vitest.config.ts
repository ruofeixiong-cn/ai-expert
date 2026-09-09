import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    // 隔离测试要串行：它们共享同一个数据库里的种子数据
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
