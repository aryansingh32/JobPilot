## 2024-06-04 - React.memo with Immutable State Management
**Learning:** The chatflow-interface frontend manages chat state immutably (e.g., in `chat-store.ts`), which makes `React.memo` highly effective for optimizing the rendering performance of dynamic lists, such as the chat message history. This prevents unnecessary re-renders of the entire history whenever parent state (like typing indicators or busy states) changes.
**Action:** Always consider `React.memo` for list items when state is managed immutably to prevent unnecessary re-renders in large lists.
