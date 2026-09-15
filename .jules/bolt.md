## 2026-06-13 - Frontend Render Optimization
**Learning:** The chat history list rendering can be optimized by using React.memo on the individual message components, since messages are immutable but new ones get appended frequently.
**Action:** When encountering dynamically updating lists of complex components (like chat messages), evaluate if applying React.memo to the item component will prevent unnecessary re-renders of older items.
