## 2024-05-18 - Memoize MessageItem for list rendering performance
**Learning:** The chat application state is managed immutably using `chat-store.ts`, which makes rendering dynamic chat history lists a highly effective candidate for React.memo to prevent deep re-renders on every new message addition.
**Action:** When adding elements to a list powered by immutable state, consider wrapping the list item component with `React.memo()` to isolate rendering updates to only the newly added items.
