## 2024-05-18 - Missing Memoization in React State
**Learning:** The `MessageItem.tsx` in `chatflow-interface` was rendering dynamic lists without memoization. Given that `chat-store.ts` manages states immutably, previous unchanged messages were being unnecessarily re-rendered whenever new messages were added.
**Action:** Always consider wrapping individual list item components in `React.memo` when rendering dynamically growing lists where items rarely update individually, but the parent list updates frequently.
