import { isStrandedShell, returnToAppServer } from "./app-origin";
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

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
        <h1>화면을 표시하지 못했습니다</h1>
        <p>잠시 문제가 발생했습니다. 다시 시도하면 작업 화면을 새로 불러옵니다.</p>
        <button type="button" className="button primary" onClick={onRetry}>
          다시 시도
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
