import { Component, type ErrorInfo, type ReactNode } from "react";

export interface FallbackProps {
  error: Error;
  /** Renders the children again (after what broke them may have changed). */
  reset: () => void;
}

interface Props {
  /** What renders instead of the children once one of them throws. */
  fallback: (p: FallbackProps) => ReactNode;
  /** Where it broke, for the console ("timeline row", "panel tab"). */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render error below it so one broken part degrades on its own instead of
 * unmounting the whole window (a drifted Claude payload, a bad persisted shape). React
 * has no hook for this; a class it is. Placed around each timeline row, each panel tab
 * body, the bottom panel and the app root (main.tsx).
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(e: unknown): State {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`code-foundry: ${this.props.label} failed to render`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) return this.props.fallback({ error, reset: this.reset });
    return this.props.children;
  }
}
