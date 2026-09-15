## 2024-07-01 - React.memo Effectiveness in Chat
**Learning:** `chatflow-interface` manages chat state immutably (e.g., in `chat-store.ts`). This architectural pattern makes `React.memo` highly effective for optimizing the rendering of dynamic lists like chat history. Without memo, appending a single message re-renders the entire message history list.
**Action:** When working on lists backed by immutable stores in this codebase, prioritize wrapping list item components (like `MessageItem`) in `React.memo` to prevent unnecessary re-renders.
