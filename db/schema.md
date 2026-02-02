# Schema (for understanding only)

Data is stored in `backend/data/jobs.json`. This file describes the logical structure for reference only — **no CREATE TABLE is run**; the app uses a JSON file and a .js store.

---

## Jobs

Conceptually, each job looks like a row in a table:

| Column          | Type   | Description                    |
|-----------------|--------|--------------------------------|
| id              | TEXT   | Primary key (e.g. UUID)       |
| status          | TEXT   | `pending` \| `running` \| `done` \| `failed` |
| payload         | TEXT   | JSON string                    |
| retries         | INT    | Number of retries so far      |
| max_retries     | INT    | Max retries before DLQ        |
| idempotency_key | TEXT   | Optional, unique per job      |
| tenant_id       | TEXT   | Per-tenant (user)              |
| created_at      | TEXT   | ISO timestamp                 |
| updated_at      | TEXT   | ISO timestamp                 |
| leased_at       | TEXT   | When worker started (optional) |
| completed_at    | TEXT   | When finished (optional)      |
| result          | TEXT   | JSON result (optional)        |
| error_message   | TEXT   | Last error (optional)         |

---

## Dead letter queue (DLQ)

Jobs that exceeded max retries are moved here:

| Column     | Type   | Description        |
|------------|--------|--------------------|
| id         | TEXT   | Primary key        |
| job_id     | TEXT   | Original job id    |
| payload    | TEXT   | Original payload   |
| retries    | INT    | Final retry count  |
| last_error | TEXT   | Last error message |
| failed_at  | TEXT   | ISO timestamp      |
| tenant_id  | TEXT   | Tenant              |

---

## SQL equivalent (reference only)

```sql
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    payload TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    idempotency_key TEXT UNIQUE,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    leased_at TEXT,
    completed_at TEXT,
    result TEXT,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS dlq (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    payload TEXT,
    retries INTEGER NOT NULL,
    last_error TEXT,
    failed_at TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default'
);
```
