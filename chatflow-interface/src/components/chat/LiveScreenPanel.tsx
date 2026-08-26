import { Monitor, X, Maximize2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InputCardMessage } from "@/lib/chat-types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface Props {
  frame: string | null;
  hot: boolean;
  onClose: () => void;
  connected?: boolean;
  activePause?: InputCardMessage | null;
  showCloseButton?: boolean;
}

export function LiveScreenPanel({
  frame,
  hot,
  onClose,
  connected = false,
  activePause = null,
  showCloseButton = true,
}: Props) {
  const [fps, setFps] = useState(0);
  const framesRef = useRef(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (frame) framesRef.current++;
  }, [frame]);

  useEffect(() => {
    const interval = setInterval(() => {
      setFps(framesRef.current);
      framesRef.current = 0;
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Use rect from active pause if available
  const rect = (activePause?.data as { rect?: { x: number; y: number; w: number; h: number } })
    ?.rect;

  const frameView = (large: boolean) => (
    <div
      className={`relative flex h-full w-full items-center justify-center overflow-hidden border border-border bg-muted/20 ${large ? "border-none bg-transparent" : "rounded-lg"}`}
    >
      {frame ? (
        <div className="relative inline-block h-full w-full text-center">
          <img
            src={frame}
            alt="Live agent view"
            className="inline-block cursor-pointer rounded-[inherit] object-contain transition-transform hover:brightness-110"
            style={{ maxHeight: large ? "85vh" : "100%", maxWidth: "100%" }}
            onClick={() => setExpanded(!large)}
          />
          {rect && (
            <div
              className="pointer-events-none absolute animate-pulse border-2 border-red-500 bg-red-500/20"
              style={{
                left: `${rect.x}%`,
                top: `${rect.y}%`,
                width: `${rect.w}%`,
                height: `${rect.h}%`,
              }}
            />
          )}
        </div>
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
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Monitor className="h-4 w-4 text-primary" />
          Live screen
          {frame ? (
            <span className="ml-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="live-dot" /> {hot ? `${fps} FPS` : "live"}
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
        {showCloseButton && (
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close live view"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="min-h-0 flex-1">{frameView(false)}</div>

        <div className="mt-3 shrink-0 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
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

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[90vh] max-w-5xl items-center justify-center border-none bg-black/95 p-4">
          <DialogTitle className="sr-only">Live agent view</DialogTitle>
          {frameView(true)}
        </DialogContent>
      </Dialog>
    </div>
  );
}
