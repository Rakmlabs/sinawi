import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// SINAWI_PORT / SINAWI_UI_PORT let a second dev copy run beside the installed app.
const apiPort = process.env.SINAWI_PORT || "3001";
// The page Vite serves carries no app key: anything on this Mac can fetch it. The dev window's key
// comes from the link scripts/dev.mjs prints, or from the app binary under `npm run app:dev`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.SINAWI_UI_PORT || 5188),
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true },
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
