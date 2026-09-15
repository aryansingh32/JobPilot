## 2024-05-24 - Wrapped MessageItem in React.memo
**Learning:** In the chat application, the `MessageItem` component was re-rendering unnecessarily every time the `typing` state or other states in its parent `Index` component changed. Given the nature of chat apps where the message list grows and the parent state changes frequently, this leads to significant performance overhead.
**Action:** Always consider wrapping list item components like `MessageItem` in `React.memo` when rendering large lists that update frequently in React applications.
