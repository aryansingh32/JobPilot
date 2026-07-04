import { Monitor, X, Maximize2, Wifi, WifiOff, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InputCardMessage } from "@/lib/chat-types";

interface Props {
  frame: string | null;
  hot: boolean;
  onClose: () => void;
  connected?: boolean;
  activePause?: InputCardMessage | null;
}

export function LiveScreenPanel({ frame, hot, onClose, connected = false, activePause = null }: Props) {
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
  const rect = (activePause?.data as any)?.rect;
  
  const content = (
    <div className={`relative overflow-hidden border border-border bg-muted/20 ${expanded ? 'h-full w-full flex items-center justify-center' : 'rounded-lg'}`}>
      {frame ? (
        <div className="relative inline-block w-full h-full text-center">
          <img
            src={frame}
            alt="Live agent view"
            className="inline-block object-contain cursor-pointer transition-transform"
            style={{ maxHeight: expanded ? '90vh' : '100%', maxWidth: '100%' }}
            onClick={() => setExpanded(!expanded)}
          />
          {rect && (
             <div 
               className="absolute border-2 border-red-500 bg-red-500/20 animate-pulse pointer-events-none"
               style={{
                 left: `${rect.x}%`,
                 top: `${rect.y}%`,
                 width: `${rect.w}%`,
                 height: `${rect.h}%`
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
      {expanded && (
        <button onClick={() => setExpanded(false)} className="absolute top-4 right-4 bg-black/50 p-2 rounded-full text-white hover:bg-black/70 z-50">
           <Minimize2 className="h-6 w-6" />
        </button>
      )}
    </div>
  );

  if (expanded) {
    return (
      <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center backdrop-blur-sm p-4">
        {content}
      </div>
    );
  }

  return (
    <div className="mx-4 my-4 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
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
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close live view"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-4">
        {content}

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
