## 2025-05-27 - Optimizing React chat list rendering
**Learning:** In a chat interface with immutable state updates (managed via zustand or similar), lists of chat messages will re-render in their entirety every time a new message arrives or the typing indicator changes unless child components are memoized.
**Action:** Always wrap list items like `MessageItem` in `React.memo` when building complex chat applications to prevent O(N^2) rendering bottlenecks on active chats.
