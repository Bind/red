import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000";

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
      "/api": {
        target: apiProxyTarget,
        // Disable buffering so SSE streams flow through immediately
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["Cache-Control"] = "no-cache";
              proxyRes.headers["Connection"] = "keep-alive";
            }
          });
        },
      },
      "/webhook": apiProxyTarget,
      "/health": apiProxyTarget,
    },
  },
});
