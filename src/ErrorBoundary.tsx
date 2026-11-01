import { isStrandedShell, returnToAppServer } from "./app-origin";
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error?: Error;
  resetKey: number;
};

export function AppErrorFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="app-error-boundary" role="alert">
      <div className="app-error-card">
        <h1>{t("errorBoundary.title")}</h1>
        <p>{t("errorBoundary.body")}</p>
        <button type="button" className="button primary" onClick={onRetry}>
          {t("common.retry")}
        </button>
      </div>
    </main>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application render failed", error, info.componentStack);
  }

  private retry = () => {
    if (isStrandedShell(location.href)) { returnToAppServer(); return; }
    this.setState(({ resetKey }) => ({ error: undefined, resetKey: resetKey + 1 }));
  };

  render() {
    if (this.state.error) return <AppErrorFallback onRetry={this.retry} />;
    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}
