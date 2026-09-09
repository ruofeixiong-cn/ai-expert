import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    // 开发期走代理，前端代码里只写 /api，不关心后端端口
    proxy: {
      // changeOrigin 保持 false：refresh token 的 Cookie 是
      // Path=/api/auth + SameSite=Strict，改写 Host 会让浏览器不回传它。
      "/api": { target: `http://localhost:${process.env.BACKEND_PORT ?? 8787}` },
      "/health": { target: `http://localhost:${process.env.BACKEND_PORT ?? 8787}` },
      "/readyz": { target: `http://localhost:${process.env.BACKEND_PORT ?? 8787}` },
    },
  },
});
