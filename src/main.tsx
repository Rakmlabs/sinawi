import { createRoot } from "react-dom/client";
import "./fonts.css";
import "./style.css";
import "./viewer.css";
// Stylesheet order is cascade order: these modules bring their own CSS and must load at the same
// point they did before the app was split into src/app/ (before polish/chat-layout overrides).
import "./RoutingControls";
import "./UsagePanel";
import "./GlassSelect";
import "./FolderPicker";
import "./polish.css";
import "./chat-layout.css";
import "./sidebar.css";
import "./team-chat.css";
import "./agent-mark.css";
import "./readability.css";
import "./terminal.css";
import "./browser.css";
import "./Onboarding";
import "./notifications.css";
import "./window-header.css";
import "./tools.css";
import "./sidebar-menu.css";
import { ErrorBoundary } from "./ErrorBoundary";
import { QuotaProvider } from "./QuotaContext";
import { blockHistoryButtons, isStrandedShell, returnToAppServer } from "./app-origin";
import { App } from "./app/App";

blockHistoryButtons();
const stranded = isStrandedShell(location.href);
// tauri://localhost = boot splash (or the WebView was walked back past the server page): never run the app here.
if (stranded) returnToAppServer();
createRoot(document.getElementById("root")!).render(
  stranded ? <div className="app-booting" role="status" /> : <ErrorBoundary>
    <QuotaProvider><App /></QuotaProvider>
  </ErrorBoundary>,
);
