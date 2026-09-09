import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    // e2e.spec.ts 不排除：它靠 describe.skipIf(E2E!=='1') 自己跳过。
    // 排除掉的话它在普通 make test 里完全不可见，容易被遗忘；
    // 显示为 skipped 才诚实。
    // 隔离测试要串行：它们共享同一个数据库里的种子数据
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
