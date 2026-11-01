import { createRoot } from "react-dom/client";
import "./tokens.css";
import "./fonts.css";
import "./style.css";
import "./viewer.css";
// Stylesheet order is cascade order: these modules bring their own CSS and must load at the same
// point they did before the app was split into src/app/ (before chat-layout overrides).
import "./RoutingControls";
import "./UsagePanel";
import "./GlassSelect";
import "./FolderPicker";
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
import "./computer-use.css";
import "./tools.css";
import "./sidebar-menu.css";
import "./beat.css";
import "./appearance.css";
import { ErrorBoundary } from "./ErrorBoundary";
import { QuotaProvider } from "./QuotaContext";
import { blockHistoryButtons, isStrandedShell, returnToAppServer } from "./app-origin";
import { App } from "./app/App";
import { initAppearance } from "./appearance";
import { subscribeLang } from "./i18n";

blockHistoryButtons();
// Theme, fonts and language before the first paint, so nothing flashes.
initAppearance();
const stranded = isStrandedShell(location.href);
// tauri://localhost = boot splash (or the WebView was walked back past the server page): never run the app here.
if (stranded) returnToAppServer();
const root = createRoot(document.getElementById("root")!);
// Fresh elements on every call: a language switch re-renders the whole tree without remounting it.
const render = () => root.render(
  stranded ? <div className="app-booting" role="status" /> : <ErrorBoundary>
    <QuotaProvider><App /></QuotaProvider>
  </ErrorBoundary>,
);
render();
subscribeLang(render);
