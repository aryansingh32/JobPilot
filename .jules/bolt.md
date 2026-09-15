## 2024-06-21 - Optimizing React Message History Renders
**Learning:** In applications managing long lists of dynamic data immutably (like chat messages in `chatflow-interface`), components rendering individual items often suffer from O(N) rendering overhead every time a single item is added.
**Action:** Always wrap list item components (e.g., `MessageItem.tsx`) in `React.memo` when the parent component manages the list state immutably. This guarantees O(1) rendering cost when appending to long lists, significantly improving perceived UI performance.
