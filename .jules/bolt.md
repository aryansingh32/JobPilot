## 2024-06-01 - [Frontend] Memoizing chat items
**Learning:** In applications where a chat history updates frequently (like adding new messages or toggling typing indicators), not memoizing the message items causes every message to re-render. Since `chat-store.ts` manages chat state immutably in this app, `React.memo` effectively skips unnecessary re-renders of old messages.
**Action:** Always verify if large lists (like chat histories or logs) component items are wrapped in `React.memo` or use virtualization when the list is backed by an immutable store.
