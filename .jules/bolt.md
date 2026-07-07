## 2024-05-18 - React.memo Optimization for Chat Messages
**Learning:** The `chatflow-interface` frontend manages chat state immutably (e.g., in `chat-store.ts`), which makes `React.memo` highly effective for optimizing the rendering performance of dynamic lists, such as the chat message history.
**Action:** Always check if dynamic list item components in the chat interface are wrapped with `React.memo` to avoid O(n) re-renders when a new item is added.
