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
    return (JSON.parse(raw) as Thread[]).filter((t) => t.messages.length > 0);
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

/** A short readable title from the first message: no URLs/markdown, cut at a word. */
function titleFrom(text: string): string {
  const t = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "New chat";
  const up = t[0].toUpperCase() + t.slice(1);
  if (up.length <= 40) return up;
  const cut = up.slice(0, 40);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20))}…`;
}

function makeThread(title = "New chat"): Thread {
  return { id: uid(), title, updatedAt: Date.now(), messages: [] };
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
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    },
    [setThreads],
  );

  const appendMessage = useCallback(
    (threadId: string, msg: ChatMessage, autoTitle = false) => {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          const messages = [...t.messages, msg];
          let title = t.title;
          if (autoTitle && t.title === "New chat" && msg.role === "user" && msg.type === "text") {
            title = titleFrom(msg.content);
          }
          return { ...t, messages, updatedAt: Date.now(), title };
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
    appendMessage,
    updateMessage,
  };
}

export { uid };
