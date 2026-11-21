import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// SINAWI_PORT / SINAWI_UI_PORT let a second dev copy run beside the installed app.
const apiPort = process.env.SINAWI_PORT || "3001";
// `npm run dev` (scripts/dev.mjs) makes the app window's key for this run; the page carries it
// (src/app-key.ts). Without it the dev page cannot approve or change settings, like any other page.
const appKey = process.env.SINAWI_APP_KEY;
delete process.env.SINAWI_APP_KEY;
const appKeyPage: Plugin = {
  name: "sinawi-app-key",
  apply: "serve",
  transformIndexHtml: () => appKey ? [{ tag: "meta", attrs: { name: "sinawi-app-key", content: appKey }, injectTo: "head-prepend" }] : [],
};
export default defineConfig({
  plugins: [react(), tailwindcss(), appKeyPage],
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
