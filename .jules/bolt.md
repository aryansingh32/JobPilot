## 2024-05-18 - React.memo effectiveness with immutable stores
**Learning:** Due to the immutable state management in `chatflow-interface/src/lib/chat-store.ts`, dynamic lists like the chat message history are prime targets for `React.memo()`. Unchanged messages will effectively skip re-rendering entirely.
**Action:** When working on lists that are driven by immutable global stores, proactively look for missing `React.memo()` wrappers on the individual list items.
