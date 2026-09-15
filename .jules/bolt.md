## 2024-05-13 - [Preventing list re-renders during high-frequency live stream]
**Learning:** The main chat view re-renders up to 30 times per second when `liveFrame` state is updated from the websocket stream. Because the message list maps over `MessageItem` without `React.memo`, this causes expensive `ReactMarkdown` and timeline components for ALL messages to unnecessarily re-render on every video frame.
**Action:** Always wrap list item components in `React.memo` when the parent component also handles high-frequency state updates (like video frames, scroll positions, or websocket ticks).
