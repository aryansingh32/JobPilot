## 2025-05-25 - React.memo on Chat MessageItem

**Learning:** Chat messages are immutable in `chatflow-interface`. Without `React.memo` on the `MessageItem` component, rendering the long list of messages will cause a full re-render of the entire chat history whenever new messages arrive or when the typing state is toggled in the parent component.

**Action:** Use `React.memo` on list components like `MessageItem` that receive immutable properties to prevent unnecessary re-renders of the whole list in React applications.
