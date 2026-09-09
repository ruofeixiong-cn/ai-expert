import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    // 开发期走代理，前端代码里只写 /api，不关心后端端口
    proxy: {
      "/api": { target: `http://localhost:${process.env.BACKEND_PORT ?? 8787}`, changeOrigin: true },
      "/health": { target: `http://localhost:${process.env.BACKEND_PORT ?? 8787}`, changeOrigin: true },
      "/readyz": { target: `http://localhost:${process.env.BACKEND_PORT ?? 8787}`, changeOrigin: true },
    },
  },
});
