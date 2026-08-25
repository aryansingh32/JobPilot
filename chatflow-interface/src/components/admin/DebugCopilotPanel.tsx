import { useState } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { Sparkles, Send } from "lucide-react";
import { adminApi } from "@/lib/admin-api";

export function DebugCopilotPanel() {
  const [question, setQuestion] = useState("Why did the most recent critical errors happen?");
  const [errorId, setErrorId] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);

  async function ask() {
    setLoading(true);
    setAnswer("");
    try {
      const res = await adminApi.observabilityCopilot({
        question,
        errorReportId: errorId.trim() || undefined,
      });
      setAnswer(res.answer);
    } catch (e) {
      setAnswer(`**Error:** ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="rounded-2xl border border-border/60 bg-card/40 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          AI debugging copilot
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Correlates persisted <span className="font-mono text-zinc-400">error_reports</span> with
          heuristics; enable <span className="font-mono">OPENAI_API_KEY</span> on the API for deep
          multi-signal reasoning.
        </p>
        <label className="mb-2 block text-[11px] uppercase tracking-wide text-muted-foreground">
          Optional error report id
        </label>
        <input
          value={errorId}
          onChange={(e) => setErrorId(e.target.value)}
          placeholder="uuid from Error intelligence…"
          className="mb-3 w-full rounded-xl border border-border/50 bg-black/30 px-3 py-2 font-mono text-xs text-foreground"
        />
        <label className="mb-2 block text-[11px] uppercase tracking-wide text-muted-foreground">
          Question
        </label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={4}
          className="w-full resize-none rounded-xl border border-border/50 bg-black/30 px-3 py-2 text-sm text-foreground"
        />
        <motion.button
          type="button"
          whileTap={{ scale: 0.98 }}
          disabled={loading || !question.trim()}
          onClick={() => void ask()}
          className="mt-3 inline-flex items-center gap-2 rounded-xl bg-primary/90 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
          {loading ? "Thinking…" : "Analyze"}
        </motion.button>
      </div>

      {answer ? (
        <div className="rounded-2xl border border-border/40 bg-card/40 p-5 text-sm leading-relaxed text-foreground [&_a]:text-primary [&_code]:rounded [&_code]:bg-black/40 [&_code]:px-1">
          <ReactMarkdown>{answer}</ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
}
