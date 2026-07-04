## 2024-07-04 - Immutable chat state and React.memo
**Learning:** The chat application manages its state immutably in `chat-store.ts`. This means that references to chat messages don't change unless the message itself is updated.
**Action:** Always wrap list items in `React.memo` (like `MessageItem`) when rendering lists based on immutably managed state (like chat histories) to easily skip unnecessary re-renders of untouched items.
