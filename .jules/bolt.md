## 2024-05-14 - React.memo on Chat Items

**Learning:** The chat interface manages state immutably (`useChatStore`), meaning old message objects retain their references. Adding `React.memo` to `MessageItem` prevents unnecessary re-rendering of the entire chat history on every typing update or new message arrival.

**Action:** Always check if list item components can be wrapped in `React.memo` when rendering large arrays from an immutable store, especially in applications with frequent, high-volume state updates like real-time chats.
