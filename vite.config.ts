import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// フロント(Vite)は 127.0.0.1:5173、API(Express)は 127.0.0.1:8787。
// /api へのリクエストはExpressにプロキシする。
export default defineConfig({
  plugins: [react()],
  root: "web",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // 先頭が正規表現。"/api/" 配下だけをプロキシする。
      // 単なる "/api" 前方一致だと、フロントのモジュール /api.ts まで
      // バックエンドへ転送され 404 になる（画面が真っ白になる原因）。
      "^/api/": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
