import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp } from "lucide-react";

/**
 * When the user is on the screen of the application that's waiting on them
 * but has scrolled away from the card, the island stays quiet — this floating
 * pill points the way instead: an arrow up (or down) to the thing to answer.
 */
export function NeedsYouHint({
  targetId,
  label = "Answer needed",
}: {
  /** DOM id of the card waiting on the user; the hint is off while it's not on the page. */
  targetId: string | null;
  label?: string;
}) {
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    setDir(null);
    if (!targetId) return;
    let io: IntersectionObserver | null = null;
    let raf = 0;
    // The card may mount a moment after its id is known.
    const attach = (tries = 0) => {
      const el = document.getElementById(targetId);
      if (!el) {
        if (tries < 20) raf = window.setTimeout(() => attach(tries + 1), 150);
        return;
      }
      io = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setDir(null);
          else setDir(entry.boundingClientRect.top < 0 ? "up" : "down");
        },
        { threshold: 0.15 },
      );
      io.observe(el);
    };
    attach();
    return () => {
      io?.disconnect();
      window.clearTimeout(raf);
    };
  }, [targetId]);

  const Arrow = dir === "up" ? ArrowUp : ArrowDown;
  return (
    <AnimatePresence>
      {dir && targetId && (
        <motion.button
          key={dir}
          initial={{ opacity: 0, y: dir === "up" ? 16 : -16, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ type: "spring", stiffness: 400, damping: 28 }}
          onClick={() =>
            document
              .getElementById(targetId)
              ?.scrollIntoView({ behavior: "smooth", block: "center" })
          }
          className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-950 py-2 pl-3 pr-4 text-[13px] font-semibold text-white shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)] ring-1 ring-white/10 sm:bottom-28"
          aria-label={`${label}: scroll ${dir}`}
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-amber-400 text-neutral-950">
            <motion.span
              animate={{ y: dir === "up" ? [0, -3, 0] : [0, 3, 0] }}
              transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}
              className="grid"
            >
              <Arrow className="h-3.5 w-3.5" strokeWidth={3} />
            </motion.span>
          </span>
          {label} — scroll {dir}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
