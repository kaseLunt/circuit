"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { logError } from "../../lib/log";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logError("Error boundary caught error", error);
    logError("Error boundary component stack", errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    const { error, hasError } = this.state;
    if (!hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    // A failure report is a note in the corner of the space the panel occupied, not a
    // centred monument to itself. The message is the thrown message verbatim: a rewritten
    // one is a guess about a cause nobody observed.
    return (
      <Card role="alert" className="h-full w-full border-destructive">
        <CardContent className="flex flex-col items-start gap-2 p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
            <p className="text-sm font-medium text-foreground">This panel failed to render</p>
          </div>
          {error !== null && error.message.length > 0 ? (
            <p className="text-xs text-muted-foreground">{error.message}</p>
          ) : null}
          <Button variant="outline" size="sm" onClick={this.handleRetry}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
}

export function InlineError({
  error,
  onRetry,
}: {
  error: Error | string | null;
  onRetry?: () => void;
}) {
  if (error === null) return null;

  const message = typeof error === "string" ? error : error.message;

  return (
    <div role="alert" className="flex items-center gap-2 text-xs">
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
      <span className="text-foreground">{message}</span>
      {onRetry === undefined ? null : (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
