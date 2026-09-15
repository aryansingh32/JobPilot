## 2026-06-02 - React.memo on Message List
**Learning:** Chat state is managed immutably in chat-store.ts, making React.memo an extremely effective, low-effort, high-impact optimization for the long lists of MessageItem components in index.tsx.
**Action:** Always look for long lists rendered from immutable state as primary targets for memoization before exploring more complex solutions like virtualization.
