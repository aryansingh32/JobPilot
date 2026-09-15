
## 2024-06-06 - Optimizing Dynamic Lists with Immutability
**Learning:** The frontend manages chat state immutably in `chat-store.ts`, which makes `React.memo` highly effective for optimizing the rendering performance of dynamic lists, such as the chat message history. This prevents O(n) re-renders when the parent component updates (e.g., when the typing indicator toggles or a new message arrives).
**Action:** Always check if a dynamic list's items are backed by an immutable state store. If so, wrapping the item component in `React.memo` is a low-risk, high-reward optimization to prevent unnecessary re-renders as the list grows.
