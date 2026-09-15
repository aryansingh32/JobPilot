
## 2023-10-24 - Immutable State Synergy
**Learning:** The frontend (`chatflow-interface`) uses immutable updates for its chat state (e.g., in `chat-store.ts`). This architectural choice makes `React.memo` highly effective for optimizing the rendering performance of dynamic lists, such as the message history, because we can easily check object references to prevent re-rendering.
**Action:** When working with dynamic lists in React within this codebase, verify whether the state updates are immutable. If so, apply `React.memo` to the list items to skip unnecessary re-renders of older elements when the list is updated.
