# Data and schema (for understanding)

- **No SQL or CREATE TABLE is run.** Data is stored in **`backend/data/jobs.json`** and managed by **`backend/store.js`**.
- **`schema.md`** contains the logical structure and a CREATE TABLE–style description **for reference only** (not executed).

Data persists across restarts; jobs and DLQ items are read/written from `backend/data/jobs.json`. Dummy data is included there to start with.
