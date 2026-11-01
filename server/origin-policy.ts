import { envVar } from "./runtime.js";

// Browser origins allowed to talk to the API, /ws and the terminal socket.
// Any other loopback port (preview proxies, the user's own dev servers) is rejected.
const DEV_PORTS = [5188, 5198];

export function appPort() {
  return Number(envVar("PORT") ?? 3001);
}

export function allowedOrigins(port = appPort()) {
  const origins = new Set(["tauri://localhost"]);
  for (const value of [port, ...DEV_PORTS]) {
    origins.add(`http://127.0.0.1:${value}`);
    origins.add(`http://localhost:${value}`);
  }
  return origins;
}

export function isAllowedOrigin(origin: string, port = appPort()) {
  return allowedOrigins(port).has(origin.toLowerCase());
}

// Sent with the built frontend. The main goal is that injected markup cannot run script;
// images, media and frames stay open because chats and the in-app browser show arbitrary URLs.
export function appContentSecurityPolicy(port = appPort()) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    // ipc: is the Tauri IPC channel used by the desktop window.
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port} ipc: http://ipc.localhost`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data: http: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
