## 2024-06-25 - React.memo for Chat Messages
**Learning:** In chat interfaces, immutable chat state updates (like appending a new message) can trigger re-renders of the entire message history list. Since older messages don't change, they are prime candidates for `React.memo`.
**Action:** Always wrap `MessageItem` (or equivalent list items) in `React.memo` when rendering a dynamic list from an immutable store (like Zustand), especially when frequent updates (like typing indicators or new messages) occur.
