import { useEffect, useRef, useState } from "react";
import { Send, Plus, X, Square, Mic, Paperclip } from "lucide-react";

interface Props {
  onSend: (text: string, files: File[]) => void;
  busy: boolean;
  onStop?: () => void;
}

// Chrome/Edge/Safari ship this under the vendor-prefixed name; there's no
// unprefixed `SpeechRecognition` yet and no TS lib.dom typing for either.
type SpeechRecognitionInstance = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
}

export function Composer({ onSend, busy, onStop }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [listening, setListening] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const speechSupported = useRef(getSpeechRecognitionCtor() !== null).current;

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  const toggleListening = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results as ArrayLike<any>)
        .map((r: any) => r[0]?.transcript ?? "")
        .join(" ");
      setText(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [text]);

  const submit = () => {
    if (busy) return;
    const t = text.trim();
    if (!t && files.length === 0) return;
    recognitionRef.current?.stop();
    onSend(t, files);
    setText("");
    setFiles([]);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  return (
    <div className="px-4 pb-4 pt-2">
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
        className={`mx-auto flex max-w-3xl flex-col rounded-3xl border bg-card shadow-sm transition ${
          drag ? "border-primary ring-2 ring-primary/30" : "border-border"
        }`}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3 sm:px-6">
            {files.map((f, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium"
              >
                <Paperclip className="h-3 w-3" />
                <span className="max-w-[160px] truncate">{f.name}</span>
                <button
                  onClick={() => setFiles((arr) => arr.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 px-2 py-2 sm:px-3">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            aria-label="Attach files"
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
            disabled={busy}
            placeholder={busy ? "Agent is working…" : "Message agent"}
            className="max-h-[200px] flex-1 resize-none bg-transparent py-2.5 text-base leading-6 placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex shrink-0 items-center gap-1.5 pb-0.5 pr-0.5">
            {busy ? (
              <button
                onClick={onStop}
                className="grid h-9 w-9 place-items-center rounded-full bg-destructive text-destructive-foreground transition-all hover:opacity-90 active:scale-90 cursor-pointer"
                aria-label="Stop"
                type="button"
              >
                <Square className="h-4 w-4" />
              </button>
            ) : listening || (!text.trim() && files.length === 0) ? (
              <button
                type="button"
                onClick={toggleListening}
                disabled={!speechSupported}
                title={speechSupported ? undefined : "Voice input isn't supported in this browser"}
                aria-pressed={listening}
                className={`flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  listening
                    ? "bg-destructive text-destructive-foreground animate-pulse"
                    : "bg-secondary text-secondary-foreground hover:bg-muted"
                }`}
              >
                <Mic className="h-4 w-4" />
                {listening ? "Listening…" : "Speak"}
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!text.trim() && files.length === 0}
                className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-foreground transition-all hover:opacity-90 active:scale-90 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
                aria-label="Send"
                type="button"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground">
        Drop files anywhere · Press Enter to send · Shift+Enter for newline
      </p>
    </div>
  );
}
