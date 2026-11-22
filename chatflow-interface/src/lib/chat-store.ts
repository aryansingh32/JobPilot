import { useEffect, useRef, useState, useCallback } from "react";
import type { ChatMessage, Thread } from "./chat-types";

// Chats live in this browser, so they're keyed by user: a second person signing in
// on the same device must never see the first one's conversations.
let scope = "anon";
const KEY = () => `agent-chat-threads-v2:${scope}`;
const ACTIVE_KEY = () => `agent-chat-active-v2:${scope}`;

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function loadThreads(): Thread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY());
    if (!raw) return [];
    // Chats nobody wrote in aren't history (older builds saved them).
    return (JSON.parse(raw) as Thread[])
      .filter((t) => t.messages.length > 0)
      .map((t) => {
        const firstUserText = t.messages.find((m) => m.role === "user" && m.type === "text");
        const originalTitle = firstUserText?.type === "text" ? legacyTitleFrom(firstUserText.content) : "";
        const isLegacyAutoTitle = Boolean(originalTitle && t.title === originalTitle);
        const title = originalTitle && t.title === originalTitle && firstUserText?.type === "text"
          ? titleFrom(firstUserText.content)
          : t.title;
        return {
          ...t,
          title: /https?:|[`*#]/.test(title) ? titleFrom(title) : title,
          titleSource: t.titleSource ?? (isLegacyAutoTitle ? "automatic" : "manual"),
        };
      });
  } catch {
    return [];
  }
}

function saveThreads(threads: Thread[]) {
  if (typeof window === "undefined") return;
  // An empty "New chat" is a blank page, not history: it is never saved.
  window.localStorage.setItem(KEY(), JSON.stringify(threads.filter((t) => t.messages.length > 0)));
}

function loadActive(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_KEY());
}

function saveActive(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_KEY(), id);
}

function cleanTitleSource(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Previous title format, used only to upgrade old auto-generated titles. */
function legacyTitleFrom(text: string): string {
  const t = cleanTitleSource(text);
  if (!t) return "New chat";
  const up = t[0].toUpperCase() + t.slice(1);
  if (up.length <= 40) return up;
  const cut = up.slice(0, 40);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20))}…`;
}

/** A short task-oriented title from the opening message. */
function titleFrom(text: string): string {
  const t = cleanTitleSource(text);
  const lower = t.toLowerCase();
  if (/\b(job|jobs|role|roles|opening|position|career)\b/.test(lower) && /\b(find|search|looking|look for|want|need|job|jobs|apply)\b/.test(lower)) {
    const rolePatterns: Array<[RegExp, string]> = [
      [/\bbackend\s+(?:developer|engineer)\b|\bback.end\s+(?:developer|engineer)\b/i, "Backend engineer"],
      [/\bfront(?:end|.end)\s+(?:developer|engineer)\b/i, "Frontend engineer"],
      [/\bfull.stack\s+(?:developer|engineer)\b/i, "Full-stack engineer"],
      [/\bdata\s+scientist\b/i, "Data scientist"],
      [/\bdata\s+analyst\b/i, "Data analyst"],
      [/\breact\s+(?:developer|engineer)\b/i, "React developer"],
      [/\bsoftware\s+(?:developer|engineer)\b/i, "Software engineer"],
      [/\b(?:qa|test)\s+(?:engineer|analyst)\b/i, "QA engineer"],
      [/\bdevops\s+engineer\b/i, "DevOps engineer"],
      [/\btech(?:nology)?\s+(?:jobs?|roles?)\b/i, "Tech jobs"],
    ];
    const role = rolePatterns.find(([pattern]) => pattern.test(lower))?.[1] ?? "Tech jobs";
    const junior = /\b(fresher|freshers|zero experience|no experience|entry.level|0 years?)\b/i.test(lower);
    const places = [
      /\bindia\b/i.test(lower) && !/\bnot\s+india\b/i.test(lower) ? "India" : "",
      /\bremote\b/i.test(lower) && !/\bnot\s+remote\b/i.test(lower) ? "remote" : "",
    ].filter(Boolean);
    const parts = [`${junior ? "Fresher " : ""}${role}`.trim(), ...places];
    return parts.join(" · ");
  }

  if (!t) return "New chat";
  const concise = t.replace(/^(?:can you|could you|please|help me|i want to|i am looking to|i'm looking to|tell me|i need to)\s+/i, "");
  const up = concise[0].toUpperCase() + concise.slice(1);
  if (up.length <= 48) return up;
  const cut = up.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24))}…`;
}

function makeThread(title = "New chat"): Thread {
  return { id: uid(), title, titleSource: "automatic", updatedAt: Date.now(), messages: [] };
}

/** Chat storage for one signed-in user; it stays empty until `userId` is known. */
export function useChatStore(userId: string | null) {
  const [threads, setThreadsState] = useState<Thread[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Idempotent bootstrap (StrictMode safe)
  useEffect(() => {
    if (typeof window === "undefined" || !userId) return;
    scope = userId;
    // The old unscoped keys may hold another person's chats.
    window.localStorage.removeItem("agent-chat-threads-v1");
    window.localStorage.removeItem("agent-chat-active-v1");
    let initial = loadThreads();
    let active = loadActive();
    if (initial.length === 0) {
      const t = makeThread();
      initial = [t];
      active = t.id;
      saveThreads(initial);
      saveActive(active);
    } else if (!active || !initial.find((t) => t.id === active)) {
      active = initial[0].id;
      saveActive(active);
    }
    setThreadsState(initial);
    setActiveIdState(active);
    setHydrated(true);
  }, [userId]);

  const setThreads = useCallback((updater: (prev: Thread[]) => Thread[]) => {
    setThreadsState((prev) => {
      const next = updater(prev);
      saveThreads(next);
      return next;
    });
  }, []);

  const threadsRef = useRef<Thread[]>([]);
  threadsRef.current = threads;
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const setActiveId = useCallback(
    (id: string) => {
      const leaving = threadsRef.current.find((t) => t.id === activeRef.current);
      setActiveIdState(id);
      saveActive(id);
      // Walking away from a chat nobody wrote in: it simply disappears.
      if (leaving && leaving.id !== id && leaving.messages.length === 0) {
        setThreads((prev) => prev.filter((t) => t.id !== leaving.id));
      }
    },
    [setThreads],
  );

  const newThread = useCallback(() => {
    // Already on a blank chat: "New chat" again just stays there.
    const current = threadsRef.current.find((t) => t.id === activeRef.current);
    if (current && current.messages.length === 0) return current.id;
    const t = makeThread();
    setThreads((prev) => [t, ...prev.filter((x) => x.messages.length > 0)]);
    setActiveIdState(t.id);
    saveActive(t.id);
    return t.id;
  }, [setThreads]);

  const deleteThread = useCallback(
    (id: string) => {
      setThreads((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          const t = makeThread();
          saveActive(t.id);
          setActiveIdState(t.id);
          return [t];
        }
        if (id === activeId) {
          saveActive(next[0].id);
          setActiveIdState(next[0].id);
        }
        return next;
      });
    },
    [activeId, setThreads],
  );

  const renameThread = useCallback(
    (id: string, title: string) => {
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title, titleSource: "manual" } : t)));
    },
    [setThreads],
  );

  const setAiTitle = useCallback(
    (id: string, title: string) => {
      const clean = title.replace(/[\r\n\"“”]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
      if (!clean) return;
      setThreads((prev) => prev.map((t) => (
        t.id === id && t.titleSource !== "manual"
          ? { ...t, title: clean, titleSource: "ai" }
          : t
      )));
    },
    [setThreads],
  );

  const appendMessage = useCallback(
    (threadId: string, msg: ChatMessage, autoTitle = false) => {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          const existingIndex = t.messages.findIndex((existing) => existing.id === msg.id);
          const messages = existingIndex < 0
            ? [...t.messages, msg]
            : t.messages.map((existing, index) => index === existingIndex ? { ...existing, ...msg } as ChatMessage : existing);
          let title = t.title;
          if (autoTitle && t.title === "New chat" && msg.role === "user" && msg.type === "text") {
            title = titleFrom(msg.content);
          }
          return {
            ...t,
            messages,
            updatedAt: Date.now(),
            title,
            titleSource: title !== t.title ? "automatic" : t.titleSource,
          };
        }),
      );
    },
    [setThreads],
  );

  const updateMessage = useCallback(
    (threadId: string, msgId: string, patch: Partial<ChatMessage>) => {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          return {
            ...t,
            messages: t.messages.map((m) =>
              m.id === msgId ? ({ ...m, ...patch } as ChatMessage) : m,
            ),
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [setThreads],
  );

  const activeThread = threads.find((t) => t.id === activeId) ?? null;

  return {
    hydrated,
    threads,
    activeId,
    activeThread,
    setActiveId,
    newThread,
    deleteThread,
    renameThread,
    setAiTitle,
    appendMessage,
    updateMessage,
  };
}

export { uid };
