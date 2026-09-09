## 2026-05-23 - Optimize captcha queue retrieval
**Learning:** The /admin/captcha/pending endpoint previously used Promise.all with individual redis.get calls for each captcha key. This results in an N+1 query problem against Redis, causing unnecessary roundtrips and latency, especially as the queue grows.
**Action:** Replaced Promise.all(redis.get) with redis.mGet() to batch all retrieval requests into a single network roundtrip, significantly improving performance.
