## 2024-05-22 - MessageItem Re-renders
**Learning:** In the chat interface, the main route re-renders the entire message list frequently (e.g., on typing indicators and status updates). Without memoization, every message in the history re-renders on every parent state change, causing unnecessary overhead.
**Action:** Use `React.memo` on list components like `MessageItem` to prevent O(N) rendering costs when parent state updates frequently.
