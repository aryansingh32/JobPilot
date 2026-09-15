## 2026-05-19 - React.memo is critical for chat interface live-frames
**Learning:** In chat interfaces with live screen casting (like this app), the parent component holding the `liveFrame` state updates extremely frequently. If the list of `MessageItem` components is not memoized, this causes O(N) re-renders across the entire chat history for every single video frame or typing tick.
**Action:** Always wrap list items in `React.memo()` in chat UIs, especially when parent state contains fast-updating metadata like video frames, typing indicators, or timestamps.
