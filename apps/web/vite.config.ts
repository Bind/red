import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    proxy: {
      "/rpc": {
        target: apiProxyTarget,
        // Disable buffering so SSE streams flow through immediately
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["Cache-Control"] = "no-cache";
              proxyRes.headers.Connection = "keep-alive";
            }
          });
        },
      },
      "/api/auth": apiProxyTarget,
      "/health": apiProxyTarget,
    },
  },
});
