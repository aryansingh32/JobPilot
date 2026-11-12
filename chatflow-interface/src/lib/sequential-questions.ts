import { useCallback, useEffect, useState } from "react";

export interface SequentialQuestion {
  id: string;
  question: string;
  options?: string[];
}

interface Draft {
  signature: string;
  index: number;
  answers: Record<string, string>;
  updatedAt: number;
}

const drafts = new Map<string, Draft>();
const CHANGE_EVENT = "jobpilot:question-sequence-change";
const DRAFT_TTL_MS = 30 * 60_000;
const MAX_DRAFTS = 100;

function signatureFor(questions: SequentialQuestion[]): string {
  return JSON.stringify(questions.map((q) => [q.id, q.question, q.options ?? []]));
}

function getDraft(scopeId: string, signature: string): Draft {
  pruneDrafts(scopeId);
  const current = drafts.get(scopeId);
  if (current?.signature === signature) return current;
  const next = { signature, index: 0, answers: {}, updatedAt: Date.now() };
  drafts.set(scopeId, next);
  return next;
}

function pruneDrafts(activeScopeId?: string): void {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const [scopeId, draft] of drafts) {
    if (scopeId !== activeScopeId && draft.updatedAt < cutoff) drafts.delete(scopeId);
  }
  while (drafts.size > MAX_DRAFTS) {
    const oldest = [...drafts.entries()].filter(([scopeId]) => scopeId !== activeScopeId)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (!oldest) break;
    drafts.delete(oldest[0]);
  }
}

function notify(scopeId: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { scopeId } }));
  }
}

export function clearSequentialQuestionDraft(scopeId: string): void {
  drafts.delete(scopeId);
  notify(scopeId);
}

/** Keeps a multi-question application in sync across chat, Applications, and the Dynamic Island. */
export function useSequentialQuestions(scopeId: string, questions: SequentialQuestion[]) {
  const signature = signatureFor(questions);
  const [draft, setDraft] = useState(() => getDraft(scopeId, signature));

  useEffect(() => {
    setDraft(getDraft(scopeId, signature));
    const onChange = (event: Event) => {
      if ((event as CustomEvent<{ scopeId: string }>).detail?.scopeId === scopeId) {
        setDraft(getDraft(scopeId, signature));
      }
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [scopeId, signature]);

  const update = useCallback((change: (current: Draft) => Draft) => {
    const current = getDraft(scopeId, signature);
    const next = { ...change(current), updatedAt: Date.now() };
    drafts.set(scopeId, next);
    pruneDrafts(scopeId);
    setDraft(next);
    notify(scopeId);
  }, [scopeId, signature]);

  const setAnswer = useCallback((id: string, value: string) => {
    update((current) => ({ ...current, answers: { ...current.answers, [id]: value } }));
  }, [update]);

  const advance = useCallback(() => {
    update((current) => ({ ...current, index: Math.min(current.index + 1, questions.length - 1) }));
  }, [questions.length, update]);

  const clear = useCallback(() => {
    clearSequentialQuestionDraft(scopeId);
    setDraft({ signature, index: 0, answers: {}, updatedAt: Date.now() });
  }, [scopeId, signature]);

  const currentIndex = Math.min(draft.index, Math.max(questions.length - 1, 0));
  return {
    answers: draft.answers,
    current: questions[currentIndex],
    index: currentIndex,
    count: questions.length,
    setAnswer,
    advance,
    clear,
  };
}
