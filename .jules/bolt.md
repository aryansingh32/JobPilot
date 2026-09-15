## 2024-05-18 - Missing Vitest Dependency
**Learning:** `npm run test` in the backend fails out-of-the-box because `vitest` is missing from the global or immediate `node_modules`.
**Action:** Always run `npm install` inside the `backend` directory before attempting to run tests.
