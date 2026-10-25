import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { ArrowUp, Paperclip, Plus, Square, X } from "lucide-react";

interface Props {
  onSend: (text: string, files: File[]) => void;
  busy: boolean;
  onStop?: () => void;
  /** "hero" = centered on the empty screen; "dock" = pinned to the bottom of a chat */
  variant?: "hero" | "dock";
}

export function Composer({ onSend, busy, onStop, variant = "dock" }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hero = variant === "hero";
  const isMobile = useIsMobile();

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Suggestion chips and receipt "what next" buttons pre-fill the composer.
  useEffect(() => {
    const onSuggest = (e: Event) => {
      setText(String((e as CustomEvent).detail ?? ""));
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener("agent-suggest", onSuggest);
    return () => window.removeEventListener("agent-suggest", onSuggest);
  }, []);

  // "Upload resume" buttons elsewhere open this composer's file picker.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const note = (e as CustomEvent).detail;
      if (typeof note === "string") setText(note);
      fileRef.current?.click();
    };
    window.addEventListener("agent-attach", onAttach);
    return () => window.removeEventListener("agent-attach", onAttach);
  }, []);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    // The placeholder changes with screen size/busy state and affects scrollHeight.
  }, [text, isMobile, busy]);

  const canSend = !busy && (text.trim().length > 0 || files.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), files);
    setText("");
    setFiles([]);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  return (
    <div className={hero ? "w-full" : "px-3 pb-3 pt-1 sm:px-4 sm:pb-4"}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const dropped = Array.from(e.dataTransfer.files);
          if (dropped.length) setFiles((f) => [...f, ...dropped]);
        }}
        className={`mx-auto flex max-w-(--chat-w) flex-col rounded-[28px] border bg-card transition-shadow dark:border-transparent dark:bg-secondary ${
          drag
            ? "border-primary ring-4 ring-primary/10"
            : "border-border shadow-[0_2px_12px_rgba(13,24,40,0.06)] focus-within:shadow-[0_4px_20px_rgba(13,24,40,0.10)]"
        }`}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {files.map((f, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-[12px] font-medium text-ink-2"
              >
                <Paperclip className="h-3 w-3" />
                <span className="max-w-[160px] truncate">{f.name}</span>
                <button
                  onClick={() => setFiles((arr) => arr.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1 p-1.5 sm:p-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Attach files"
            title="Attach files"
            type="button"
          >
            <Plus className="h-5 w-5" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const arr = Array.from(e.target.files ?? []);
              if (arr.length) setFiles((f) => [...f, ...arr]);
              e.target.value = "";
            }}
          />
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              busy
                ? "Working on it…"
                : hero
                  ? isMobile
                    ? "Search roles, or tell me what you need…"
                    : "Try “remote React jobs in Bangalore” or “apply to this job” + a link"
                  : "Message jobpilot…"
            }
            className={`max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-[16px] leading-6 text-foreground placeholder:text-faint focus:outline-none ${
              hero ? "sm:py-2.5" : ""
            }`}
          />
          {busy ? (
            <button
              onClick={onStop}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-foreground text-background transition-transform active:scale-90"
              aria-label="Stop"
              type="button"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-all active:scale-90 disabled:bg-muted disabled:text-faint"
              aria-label="Send"
              type="button"
            >
              <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
