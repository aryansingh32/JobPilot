## 2024-05-18 - Chat Message List Re-rendering
**Learning:** The chat interface manages state immutably in `chat-store.ts`, meaning new messages create new arrays. Without React.memo on the `MessageItem` component, appending a single new message forces React to re-render all preceding historical messages because the parent `messages` array changed.
**Action:** Always wrap list items in `React.memo()` when rendering long historical lists that are purely additive (like chat logs), provided the items only depend on their own stable props.
