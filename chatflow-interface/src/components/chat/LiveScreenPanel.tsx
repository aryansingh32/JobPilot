import { Monitor, X, Maximize2 } from "lucide-react";
import { useState } from "react";
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
  const [expanded, setExpanded] = useState(false);

  // Use rect from active pause if available
  const rect = (activePause?.data as { rect?: { x: number; y: number; w: number; h: number } })
    ?.rect;

  const frameView = (large: boolean) => (
    <div
      className={`relative flex h-full w-full items-center justify-center overflow-hidden border border-border bg-background ${large ? "border-none bg-transparent" : "rounded-[14px]"}`}
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
            <Maximize2 className="h-5 w-5 text-faint" />
          </div>
          <div className="space-y-1">
            <div className="text-[13px] font-semibold text-foreground">Nothing running yet</div>
            <div className="max-w-[220px] text-[12px] leading-relaxed text-muted-foreground">
              When I start a task you'll see the real browser here, step by step.
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            <Monitor className="h-4 w-4 text-primary" />
            Live view
            {frame && hot && (
              <span className="flex items-center gap-1.5 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary-soft-foreground">
                <span className="live-dot h-1.5 w-1.5" /> Live
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            The real browser doing your task.
          </p>
        </div>
        {showCloseButton && (
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close live view"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="min-h-0 flex-1">{frameView(false)}</div>
        <p className="mt-3 shrink-0 text-[12px] leading-relaxed text-muted-foreground">
          {connected || frame
            ? "Tap the screen to enlarge. You can leave this page — I'll keep going and save a receipt."
            : "Reconnecting… the view will come back on its own."}
        </p>
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
