import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { trackClientError } from "@/lib/client-telemetry";

/**
 * Contains a crash to the screen it happened on: the sidebar and everything
 * else stay up, and the user can retry instead of facing a blank page.
 */
export class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    trackClientError(error, {
      boundary: "view",
      componentStack: info.componentStack?.slice(0, 600),
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid flex-1 place-items-center px-6">
        <div className="max-w-sm text-center">
          <p className="text-[16px] font-semibold text-foreground">This part didn't load</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Everything else is fine, and nothing you did was lost.
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-[13px] font-semibold text-primary-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Try again
          </button>
        </div>
      </div>
    );
  }
}
