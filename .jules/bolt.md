## 2024-05-24 - React.memo on Chat Messages
**Learning:** The chat interface manages chat state immutably via `chat-store.ts`, making it a perfect candidate for `React.memo` on the `MessageItem` component. Because the `msg` object reference remains unchanged for older messages, `React.memo` successfully skips re-rendering the entire historical chat log when a new message is appended.
**Action:** Always look for long, dynamically growing lists in React where state is managed immutably to apply `React.memo` for significant rendering performance gains.
