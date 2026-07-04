import { Monitor, X, Maximize2, Wifi, WifiOff } from "lucide-react";

interface Props {
  frame: string | null;
  hot: boolean;
  onClose: () => void;
  connected?: boolean;
}

export function LiveScreenPanel({ frame, hot, onClose, connected = false }: Props) {
  return (
    <div className="mx-4 my-4 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Monitor className="h-4 w-4 text-primary" />
          Live screen
          {frame ? (
            <span className="ml-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="live-dot" /> {hot ? "high FPS" : "live"}
            </span>
          ) : (
            <span className="ml-1 flex items-center gap-1 text-[11px]">
              {connected ? (
                <>
                  <Wifi className="h-3 w-3 text-primary" />{" "}
                  <span className="text-muted-foreground">connected</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-3 w-3 text-muted-foreground" />{" "}
                  <span className="text-muted-foreground">offline</span>
                </>
              )}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close live view"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-4">
        <div className="relative overflow-hidden rounded-lg border border-border bg-muted/20">
          {frame ? (
            <img
              src={frame}
              alt="Live agent view"
              className="block aspect-video w-full object-cover"
            />
          ) : (
            <div className="flex aspect-video flex-col items-center justify-center gap-3 text-center text-xs text-muted-foreground">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Maximize2 className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <div className="font-medium text-foreground">Agent Standby</div>
                <div className="max-w-[200px] text-[11px] leading-relaxed opacity-70">
                  Awaiting task instructions. Live automation feed will appear here.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
          <div className="flex gap-2 items-center">
            <span className="text-primary">⚡</span>
            <p>Frames stream securely in real time during automation.</p>
          </div>
          {!connected && (
            <div className="flex gap-2 items-center text-warning">
              <span>⚠️</span>
              <p>Backend disconnected. Frames will resume when session is active.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
