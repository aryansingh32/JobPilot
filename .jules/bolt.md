## 2026-05-20 - Prevent unnecessary re-renders in Chat
**Learning:** In a heavily populated chat UI, mapping over the array of messages inherently triggers re-renders on every `MessageItem` when the list changes. This can cause severe input latency and scroll jitter as the application scales.
**Action:** Wrapped the `MessageItem` component in `React.memo()` to ensure each historical message only renders when its specific props change, rather than on every parent re-render.
