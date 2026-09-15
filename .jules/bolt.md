## 2024-05-18 - Prevented Unnecessary Re-Renders in Message History
**Learning:** In a chat interface (`chatflow-interface`), appending new messages or typing in the composer frequently triggers parent re-renders. Since chat history state is managed immutably, individual message components re-render unnecessarily without memoization.
**Action:** Wrapped the `MessageItem` component with `React.memo()`. When implementing rendering optimizations for long static or mostly-static lists, always consider `React.memo` to skip diffing components that haven't changed.
