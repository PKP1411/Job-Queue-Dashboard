# Implementation Details

This document describes **what is implemented**, **which file handles what**, **how queue fetching works**, and **how retry works** in detail.

---

## 1. File-by-file: features and call flow

### 1.1 `backend/config.js`

**Role:** Read environment variables and expose configuration.

**What it does:**
- Loads `.env` via `dotenv`.
- Exports: `PORT`, `API_KEY`, `MAX_CONCURRENT_PER_TENANT`, `MAX_NEW_JOBS_PER_MINUTE`, `LEASE_TIMEOUT_SEC`, `POLL_MS`, `WORKER_CONCURRENCY`, `MAX_RETRIES`.

**Who calls it:** `main.js`, `worker.js` (both `require('./config')`).

---

### 1.2 `backend/logger.js`

**Role:** Structured JSON logging for observability.

**What it does:**
- Single function `log(level, event, data)`; exports `info`, `warn`, `error`.
- Each log line is JSON with: `ts`, `level`, `event`, and optional `traceId`, `jobId`, `tenantId`, `message`, `error`.

**Who calls it:** `main.js` (auth failed, rate limit, submit, request_error), `worker.js` (lease, ack, retry, dlq, job_failed, lease_timeout, worker_start).

---

### 1.3 `backend/store.js`

**Role:** Single source of truth for jobs and DLQ; reads/writes `backend/data/jobs.json`.

**Data file:** `backend/data/jobs.json` — structure `{ jobs: [...], dlq: [...] }`.

**Small features and functions:**

| Function | What it does | Who calls it |
|----------|--------------|--------------|
| `load()` | Reads `jobs.json`, parses JSON; returns `{ jobs, dlq }` or default. Creates `data/` if missing. | Used internally by all other store functions. |
| `save(data)` | Writes full `jobs` and `dlq` arrays to `jobs.json` (no trimming; full history kept). | `createJob`, `updateJob`, `addToDlq`. |
| `getJob(id)` | Loads data, returns job object or null. | `main.js` (GET /jobs/:id, rowToJob), `worker.js` (leaseOne, retry, runOneJob payload). |
| `getJobs(status, limit, offset)` | Loads data, optionally filters by status, sorts by `created_at` desc, slices. | `main.js` (GET /jobs). |
| `createJob(job)` | Loads, pushes job to `data.jobs`, saves. | `main.js` (POST /jobs). |
| `updateJob(id, updates)` | Loads, finds job by id, merges updates, saves. | `worker.js` (leaseOne, ack, retry, sendToDlq), `main.js` (if retry endpoint exists). |
| `countByStatus(status)` | Loads, counts jobs where `j.status === status`. | `main.js` (GET /metrics). |
| `countRunningByTenant(tenantId)` | Loads, counts jobs where `tenant_id === tenantId` and `status === 'running'`. | `main.js` (checkConcurrent). |
| `findJobByIdempotencyKey(key)` | Loads, returns first job with `idempotency_key === key` or null. | `main.js` (POST /jobs with Idempotency-Key). |
| `getNextPendingJob()` | Loads, returns first job where `status === 'pending'` (order is array order). | `worker.js` (leaseOne). |
| `getStaleRunningJobs(maxAgeMs)` | Loads, returns jobs with `status === 'running'` and `now - leased_at > maxAgeMs`. | `worker.js` (releaseStaleLeases). |
| `releaseStaleJob(id)` | Sets that job to `status: 'pending'`, `leased_at: null`, `updated_at: now`. | `worker.js` (releaseStaleLeases). |
| `listDlq()` | Loads, returns `data.dlq` sorted by `failed_at` desc. | `main.js` (GET /dlq). |
| `addToDlq(item)` | Loads, pushes item to `data.dlq`, saves. | `worker.js` (sendToDlq). |
| `getDlqCount()` | Loads, returns `data.dlq.length`. | `main.js` (GET /metrics). |

**Important:** Every write goes through `save()`, which writes the full job and DLQ history (no trimming).

---

### 1.4 `backend/main.js`

**Role:** REST API server (Express). Handles HTTP requests, rate limits, idempotency, and reads/writes via `store`.

**Dependencies:** `express`, `cors`, `uuid`, `./store`, `./logger`, `./config`.

**Request flow (middleware order):**
1. `cors()` — allow cross-origin.
2. `express.json()` — parse JSON body.
3. **Trace ID** — set `req.traceId` from header `X-Trace-Id` or generate; set response header `X-Trace-Id`.
4. **Optional API key** — if `config.API_KEY` is set, require `X-API-Key` or `Authorization: Bearer <key>`; else 401.

**Endpoints and logic:**

| Method | Path | Handler logic | Calls to store |
|--------|------|---------------|-----------------|
| GET | `/health` | Return `{ status, uptime, timestamp }`. | None. |
| POST | `/jobs` | 1) `getTenant(req)` → `X-Tenant-Id` or `'default'`. 2) `checkConcurrent(tenantId)` → `store.countRunningByTenant(tenantId)`; if ≥ config max → 429. 3) `checkRate(tenantId)` → in-memory sliding window per tenant; if ≥ 10/min → 429. 4) If `Idempotency-Key` header: `store.findJobByIdempotencyKey(key)`; if found, return that job (200). 5) Else: create job object (id, status `'pending'`, payload, retries 0, max_retries, tenant_id, etc.), `store.createJob(job)`, return 201. | `countRunningByTenant`, `findJobByIdempotencyKey`, `createJob`. |
| GET | `/jobs/:id` | `store.getJob(req.params.id)`; if null → 404; else `rowToJob(row)` and return. | `getJob`. |
| GET | `/jobs` | Query `status`, `limit`, `offset`. `store.getJobs(status, limit, offset)`; return `{ jobs: rows.map(rowToJob), limit, offset }`. | `getJobs`. |
| GET | `/dlq` | `store.listDlq()`; return `{ items }`. | `listDlq`. |
| GET | `/metrics` | Return in-memory `metrics` (jobs_submitted, etc.) plus `store.countByStatus('pending'|'running'|'done'|'failed')`, `store.getDlqCount()`. | `countByStatus`, `getDlqCount`. |

**Helper functions:**
- `getTenant(req)` — header `X-Tenant-Id` or `'default'`.
- `checkConcurrent(tenantId)` — uses `store.countRunningByTenant(tenantId)`.
- `checkRate(tenantId)` — in-memory array of timestamps per tenant; drop older than 60s; if length ≥ max → throw 429.
- `rowToJob(row)` — maps DB row to API shape (parses `payload` and `result` JSON).

---

### 1.5 `backend/worker.js`

**Role:** Job processor. Fetches pending jobs from the queue (via store), leases them, processes, then either acks (done), retries (back to pending), or sends to DLQ.

**Dependencies:** `./store`, `./logger`, `./config`.

**Variables:**
- `inFlight` — number of jobs currently being processed (concurrency cap).
- Uses config: `POLL_MS`, `MAX_RETRIES`, `LEASE_TIMEOUT_MS`, `WORKER_CONCURRENCY`.

**Functions and who calls whom:**

| Function | What it does | Calls |
|----------|--------------|-------|
| `processJob(payload)` | Validates payload; if invalid/fail/empty/long/forbidden → throws Error with message. Else simulates work (1s per character, min 1s max 30s), returns result. | — |
| `releaseStaleLeases()` | Gets stale running jobs from store; for each, calls `store.releaseStaleJob(job.id)`; logs. | `store.getStaleRunningJobs`, `store.releaseStaleJob`, `logger.warn`. |
| `leaseOne()` | Gets one pending job from store; if none, returns null. Else updates that job to `status: 'running'`, `leased_at: now`; re-reads job; if still running, returns it and logs. | `store.getNextPendingJob`, `store.updateJob`, `store.getJob`, `logger.info`. |
| `ack(jobId, result)` | Updates job to `status: 'done'`, `completed_at`, `result` (JSON string). | `store.updateJob`, `logger.info`. |
| `retry(jobId, errorMessage)` | Loads job; updates to `status: 'pending'`, `leased_at: null`, `error_message`, increments `retries`. | `store.getJob`, `store.updateJob`, `logger.info`. |
| `sendToDlq(job, lastError, finalRetries)` | Appends DLQ item (job_id, payload, retries, last_error, failed_at, tenant_id); updates job to `status: 'failed'`, `completed_at`, `error_message: lastError`. | `store.addToDlq`, `store.updateJob`, `logger.info`. |
| `runOneJob(job)` | Parses job.payload; computes currentRetries = job.retries + 1; tries `processJob(payload)` → on success `ack(job.id, result)`; on catch: if currentRetries ≥ max_retries → `sendToDlq(job, errMsg, currentRetries)`, else `retry(job.id, errMsg)`. | `processJob`, `ack`, `retry`, `sendToDlq`, `store.updateJob`. |
| `tryLeaseAndStart()` | Calls `releaseStaleLeases()`; then while `inFlight < WORKER_CONCURRENCY`: `job = leaseOne()`; if null break; inFlight++; runOneJob(job).finally( inFlight--; tryLeaseAndStart() ). | `releaseStaleLeases`, `leaseOne`, `runOneJob`. |

**Startup:** Calls `tryLeaseAndStart()` once; then `setInterval(tryLeaseAndStart, POLL_MS)` so it re-runs every 2s (and also whenever a job finishes via `.finally`).

---

### 1.6 `frontend/src/api.js`

**Role:** HTTP client for the backend. All requests go to `BASE = '/api'` (Vite proxies to backend).

**Functions:** `healthCheck()`, `submitJob(payloadOrText, options)`, `getJob(id)`, `listJobs(status, options)`, `listDlq()`, `getMetrics()`. Optional `apiKey`, `tenantId`, `idempotencyKey` in options.

---

### 1.7 `frontend/src/App.jsx`

**Role:** Dashboard UI. Fetches jobs, DLQ, metrics; submit form; quick buttons; filter by status; Retry (if backend exposes retry endpoint); progress for running jobs; polling + optional WebSocket.

**Calls:** `api.submitJob`, `api.listJobs`, `api.listDlq`, `api.getMetrics`, and optionally retry API if implemented.

---

## 2. How fetching from the queue works (step-by-step)

The queue is the **list of jobs** in `store` with `status: 'pending'`. Fetching = “get the next job and mark it as running so no other worker takes it.”

### 2.1 Where the queue lives

- **Storage:** `backend/data/jobs.json` → key `jobs` (array).
- **Pending jobs:** Any job with `status === 'pending'`.

There is no separate “queue” process; the worker **polls the store** and picks pending jobs.

### 2.2 Who fetches

- **Only the worker** (`backend/worker.js`) fetches jobs for processing.
- The API never fetches for processing; it only creates jobs (POST /jobs) and reads them (GET /jobs, GET /jobs/:id).

### 2.3 Fetch flow (worker)

1. **Entry point:** `tryLeaseAndStart()` is called:
   - On a timer: `setInterval(tryLeaseAndStart, POLL_MS)` (e.g. every 2000 ms).
   - When a slot frees: inside `runOneJob(job).finally(..., tryLeaseAndStart)`.

2. **Release stale leases first:**  
   `releaseStaleLeases()`:
   - Calls **`store.getStaleRunningJobs(LEASE_TIMEOUT_MS)`**.
   - Store: `load()` → filter jobs where `status === 'running'` and `(now - leased_at) > LEASE_TIMEOUT_MS`.
   - For each such job: **`store.releaseStaleJob(job.id)`** → set `status: 'pending'`, `leased_at: null`, then `save()`.
   - So “stuck” running jobs become pending again and can be re-fetched.

3. **Fill concurrency slots:**  
   Loop while `inFlight < WORKER_CONCURRENCY`:
   - **`leaseOne()`**:
     - **`store.getNextPendingJob()`** → store does `load()`, then `data.jobs.find(j => j.status === 'pending')`. Returns first pending job or null.
     - If null, `leaseOne()` returns null → loop breaks.
     - If job found: **`store.updateJob(job.id, { status: 'running', updated_at: now, leased_at: now })`** → store loads, finds job, merges, **save()**.
     - Then **`store.getJob(job.id)`** to get updated job (optional sanity check).
     - Return that job (worker now “holds” this job).
   - Worker increments `inFlight`, calls **`runOneJob(job)`** (async). When `runOneJob` finishes, in `.finally()` it decrements `inFlight` and calls **`tryLeaseAndStart()`** again to refill.

4. **Summary:**  
   - **Fetch** = `store.getNextPendingJob()` (read first pending).  
   - **Claim** = `store.updateJob(id, { status: 'running', leased_at })` (so same job is not given to another worker).  
   - All of this happens in **`worker.js`**; **`store.js`** only exposes `getNextPendingJob()` and `updateJob()`.

---

## 3. How retry works (step-by-step)

Retry has two parts: (1) **worker-side retry** (job fails, worker re-queues it as pending), and (2) **API-side retry** (e.g. POST /jobs/:id/retry to create a new job from a failed/DLQ job) if that endpoint exists.

### 3.1 Worker-side retry (re-queue after failure)

**Where:** `backend/worker.js` → `runOneJob(job)`.

**Flow:**

1. Before processing:  
   `currentRetries = (job.retries || 0) + 1`  
   This is “this attempt counts as attempt number currentRetries”.

2. **Try process:**  
   `result = await processJob(payload)`.  
   If it throws, we go to the catch block.

3. **Catch block:**  
   - `errMsg = err.message` (e.g. "Text length exceeds maximum (31 > 30 characters)").
   - Log: `logger.warn('job_failed', { jobId, error: errMsg })`.
   - **Decision:**
     - If **`currentRetries >= (job.max_retries || MAX_RETRIES)`** (e.g. ≥ 3):
       - **No more retries** → send to DLQ:
         - `store.updateJob(job.id, { error_message: errMsg })`.
         - **`sendToDlq(job, errMsg, currentRetries)`**:
           - Creates DLQ item: `{ id, job_id, payload, retries: finalRetries, last_error: errMsg, failed_at, tenant_id }`.
           - **`store.addToDlq(item)`** → append to `data.dlq`, save.
           - **`store.updateJob(job.id, { status: 'failed', completed_at, error_message: errMsg })**.
     - Else:
       - **Retry** → put job back to pending:
         - **`retry(job.id, errMsg)`**:
           - **`store.getJob(jobId)`** (to read current retries).
           - **`store.updateJob(jobId, { status: 'pending', updated_at, leased_at: null, error_message: errMsg, retries: (job.retries || 0) + 1 })`**.
         - Job reappears as **pending**; on next `tryLeaseAndStart()` / `leaseOne()`, **`getNextPendingJob()`** can return it again.

4. **Retry count:**  
   Stored on the **job** as `retries`. Each time the worker calls `retry()`, it sets `retries: job.retries + 1`. So after one failure we have retries=1, then pending; next run we process again; if it fails again, retries=2, then pending; third failure → retries=3, and if max_retries is 3, we send to DLQ.

**Summary:**  
- **Retry** = worker calls **`retry(job.id, errMsg)`** → store updates job to **pending** and increments **retries**.  
- **DLQ** = when **retries ≥ max_retries**, worker calls **`sendToDlq(...)`** → store **addToDlq** + update job to **failed**.  
- All of this is in **`worker.js`**; **`store.js`** provides **`updateJob`**, **`addToDlq`**, **`getJob`**.

### 3.2 API retry (create new job from failed/DLQ job)

If the backend has **POST /jobs/:id/retry** (not in the current `main.js` snippet), it would:

- Load the job (or DLQ item by job_id).
- Create a **new** job with the same payload, `status: 'pending'`, `retries: 0`.
- Call **`store.createJob(newJob)`**.

That is “retry” from the API’s point of view: a new job, so the worker will fetch it again via **getNextPendingJob** and process it from scratch.

---

## 4. Call flow summary (who calls what)

```
main.js (POST /jobs)
  → getTenant, checkConcurrent(tenantId) → store.countRunningByTenant
  → checkRate(tenantId) (in-memory)
  → [optional] store.findJobByIdempotencyKey
  → store.createJob(job)

main.js (GET /jobs, /jobs/:id, /dlq, /metrics)
  → store.getJobs / getJob / listDlq / countByStatus / getDlqCount

worker.js (loop)
  → tryLeaseAndStart
      → releaseStaleLeases
          → store.getStaleRunningJobs(LEASE_TIMEOUT_MS)
          → store.releaseStaleJob(job.id) per stale job
      → while (inFlight < CONCURRENCY):
          → leaseOne
              → store.getNextPendingJob()   ← FETCH FROM QUEUE
              → store.updateJob(id, { status:'running', leased_at })   ← CLAIM
              → store.getJob(id)
          → runOneJob(job)
              → processJob(payload)  [may throw]
              → on success: ack(job.id, result) → store.updateJob(id, { status:'done', ... })
              → on failure:
                  if currentRetries >= max_retries:
                    sendToDlq(job, errMsg) → store.addToDlq + store.updateJob(id, { status:'failed', ... })
                  else:
                    retry(job.id, errMsg) → store.getJob + store.updateJob(id, { status:'pending', retries+1, ... })
```

---

## 5. Configuration (implementation)

All tunables come from **`backend/config.js`** (env via `.env`):  
`PORT`, `API_KEY`, `MAX_CONCURRENT_PER_TENANT`, `MAX_NEW_JOBS_PER_MINUTE`, `LEASE_TIMEOUT_SEC`, `POLL_MS`, `WORKER_CONCURRENCY`, `MAX_RETRIES`.  
No code change needed; override in `.env`.

---

For **auto-scaling workers** and **design trade-offs**, see [DESIGN_AND_SCALING.md](./DESIGN_AND_SCALING.md).  
For **setup and quick start**, see [README.md](./README.md).

---

## 6. Highlighted features (reference)

### Core

| Feature | What it does |
|--------|----------------|
| **REST Job API** | Submit jobs (`POST /jobs`), check status (`GET /jobs/:id`), list by status. Optional **idempotency key** to avoid duplicate submissions. |
| **Persistence** | All jobs and DLQ items in `backend/data/jobs.json`; metrics in `backend/data/metrics.json`. Full history kept — no trimming. Survives restarts. |
| **Worker: Lease → Ack → Retry → DLQ** | Workers **lease up to 5 jobs concurrently**, process each, then **ack** (done) or **retry** (re-queue). After max retries, job moves to **Dead Letter Queue (DLQ)**. |
| **Rate limits** | Per-tenant: **10 new jobs per minute**. New jobs wait in queue; worker processes up to 5 at a time. |
| **Dashboard (React)** | View **Pending / Running / Done / Failed** jobs and **DLQ**. Submit jobs and see status. |
| **Observability** | **Structured JSON logs** (event, jobId, traceId). **GET /metrics** (counts). **GET /health** (uptime). |

### Beyond core

| Feature | Why it stands out |
|--------|--------------------|
| **Real-time updates** | Dashboard polls and updates when jobs change (lease, ack, retry, DLQ). |
| **Retry failed/DLQ jobs from UI** | **Retry** button on failed jobs and DLQ rows. Creates a **new job with the same payload**. |
| **Text-based jobs, 1 sec per character** | Processing time = **1 second per character** (min 1s, max 30s). |
| **Lease timeout** | Stuck “running” jobs are re-queued after 5 minutes if worker dies. |
| **Optional API key auth** | Set `API_KEY` in `.env`; clients send **X-API-Key**. |
| **Trace ID** | Every API response includes **X-Trace-Id** for correlation. |
| **Pagination** | `GET /jobs?limit=20&offset=0`. |
| **Tests** | `npm test` in backend runs health, submit, get, idempotency, list, metrics. |

---

## 7. Using the dashboard

### Submitting a job

1. **Text to process** — Enter any text. Processing time = **1 second per character** (e.g. `Hello` = 5 seconds).
2. Click **Submit job**, or use **Quick submit** buttons.

### Job states

- **Pending** — Waiting for a worker.
- **Running** — Worker is processing (row pulses). Duration = length of the text in seconds.
- **Done** — Completed successfully.
- **Failed** — Failed after max retries; may appear in **DLQ** as well.

### Retrying a failed or DLQ job

1. Find the job in **Failed** or **Dead letter queue**.
2. Click **Retry** on that row (if the backend exposes retry). A new job with the same payload is created and appears in **Pending**.

### DLQ failure reasons (demo)

| Reason | How to trigger | Example message |
|--------|----------------|-----------------|
| **Text length > 30** | Submit text with more than 30 characters | `Text length exceeds maximum (31 > 30 characters)` |
| **Simulated failure** | Payload `{ "fail": true }` | `Simulated failure for testing` |
| **Empty text** | Submit with empty or missing text | `Payload must include non-empty text` |
| **Forbidden content** | Text contains the word `reject` | `Job rejected: forbidden content` |
| **Invalid payload** | Payload `{ "invalid": true }` | `Invalid payload format (invalid=true)` |

### Optional: API key and tenant

- **API key** — If backend has `API_KEY` set, send it (e.g. in dashboard) for auth.
- **Tenant ID** — Optional header for multi-tenant rate limits (default: `default`).

---

## 8. Architecture (flow)

```
┌─────────────┐     POST /jobs      ┌─────────────┐     read/write     ┌──────────────┐
│  Dashboard  │ ──────────────────► │  API        │ ◄────────────────► │ jobs.json    │
│  (React)    │ ◄── polling ──────── │  (Express)  │                    │ (persistence) │
└─────────────┘                     └──────┬──────┘                    └──────────────┘
                                            │
                                            ▼
                                     ┌─────────────┐     poll + lease   ┌──────────────┐
                                     │  Worker     │ ◄────────────────► │ jobs.json     │
                                     │  (Node)     │     ack / retry     │               │
                                     └─────────────┘     DLQ            └──────────────┘
```

1. **User** submits from the dashboard.
2. **API** validates rate limits, creates a job, writes to **jobs.json**, returns job id.
3. **Worker** polls, **leases up to 5 pending jobs** (status → running), processes each.
4. **Worker** acks (status → done), retries (back to pending), or sends to **DLQ** after max retries.
5. **Dashboard** polls and shows **pending → running → done** (or failed/DLQ).

---

## 9. API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check. Returns `{ status: "ok", uptime }`. |
| POST | `/jobs` | Submit job. Body: **`{ "text": "..." }`** or `{ "payload": { ... } }`. Headers: `Idempotency-Key`, `X-Tenant-Id`, `X-API-Key` (optional). |
| POST | `/jobs/:id/retry` | **Retry** a failed or DLQ job. Creates a new job with the same payload. |
| GET | `/jobs` | List jobs. Query: `?status=pending|running|done|failed`, `?limit=20`, `?offset=0`. |
| GET | `/jobs/:id` | Get one job by id. |
| GET | `/dlq` | List dead-letter queue items. |
| GET | `/metrics` | Counts: pending, running, done, failed, dlq_count, jobs_submitted, retries. |

All HTTP responses include **X-Trace-Id** for correlation.

---

## 10. Configuration (backend)

Copy `backend/.env.example` to `backend/.env` to override:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8000 | API port. |
| `API_KEY` | (none) | If set, clients must send `X-API-Key`. |
| `RATE_LIMIT_PER_MINUTE` | 10 | Max new jobs per tenant per minute. |
| `LEASE_TIMEOUT_SEC` | 300 | Re-queue “running” jobs after this many seconds (stale lease). |
| `MAX_RETRIES` | 3 | Retries before moving job to DLQ. |
| `WORKER_POLL_MS` | 2000 | Worker poll interval in ms. |
| `WORKER_CONCURRENCY` | 5 | Max jobs processed at once (capped at 5). |

---

## 11. Project structure

```
Nurix AI Project by Prakash Kumar/
├── README.md                 ← Setup and how it works
├── IMPLEMENTATION.md         ← This file (flows, files, reference)
├── DESIGN_AND_SCALING.md     ← Auto-scale workers + design trade-offs
├── backend/
│   ├── main.js               ← API server
│   ├── worker.js             ← Job processor (lease / ack / retry / DLQ)
│   ├── store.js              ← File-backed store (jobs.json)
│   ├── config.js             ← Env configuration
│   ├── logger.js             ← Structured JSON logs
│   ├── package.json
│   ├── .env.example
│   ├── data/
│   │   └── jobs.json         ← Persistent jobs + DLQ
│   └── tests/
│       └── api.test.js       ← API tests (npm test)
├── frontend/
│   ├── src/
│   │   ├── App.jsx           ← Dashboard (submit, list, retry)
│   │   ├── api.js            ← API client
│   │   └── App.css
│   ├── index.html
│   └── vite.config.js        ← Proxy /api to backend
└── db/
    ├── schema.md             ← Schema reference
    └── README.md
```

---

## 12. Tests

With the **API running** in another terminal:

```bash
cd backend
npm test
```

Covers: health, submit job, get job, idempotency key, list jobs, metrics.

---

## 13. Design trade-offs

| Area | Choice | Trade-off |
|------|--------|-----------|
| **Storage** | JSON file | No DB server; simple. For scale, switch to Postgres/Redis with same API. |
| **Workers** | Single process, poll | Easy to run. Scale by running multiple workers; use atomic lease in DB for safety. |
| **Live updates** | Polling | Simple; no WebSocket in current setup. |
| **Auth** | Optional API key | Good for prototype; use JWT/OAuth for production. |
| **Lease timeout** | Re-queue stuck jobs | Prevents permanent blockage if worker dies; tune timeout to avoid duplicate work. |

---

## 14. Evaluation focus mapping

| Focus | Where it’s covered |
|-------|--------------------|
| **Correctness** | Lease/ack/retry/DLQ in `worker.js`; idempotency in `main.js`; lease timeout; retry from UI. |
| **Reliability** | Persistence in `jobs.json`; survives restarts; lease timeout. |
| **API & UX** | REST; dashboard with submit, status tabs, DLQ, **Retry**. |
| **Observability** | Structured logs; `/metrics` and `/health`; trace ID; job ID in logs. |
| **Code quality** | Modular backend; comments; `npm test`; README and IMPLEMENTATION.md. |

---

## 15. Security (hardening)

- **API key:** Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks.
- **Input validation:** Tenant ID and idempotency key length-capped and sanitized; job id validated for lookups; `status` in GET /jobs restricted; `limit`/`offset` validated and bounded.
- **Payload:** Only allowed keys (`text`, `fail`, `invalid`) are stored to avoid prototype pollution.
- **Security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- **Error responses:** 500 handler returns a generic message so internal details are not leaked.
- **Store:** Max file size on load; job id and tenant/idempotency key length limits; safe JSON parse in API and worker.
- **Dependencies:** Run `npm audit` in backend and frontend and fix reported issues.

---

## 16. Quick reference

| Goal | Command / Action |
|------|------------------|
| Start API | `cd backend && npm start` |
| Start worker | `cd backend && npm run worker` |
| Start dashboard | `cd frontend && npm run dev` → open http://localhost:5173 |
| Submit job | Dashboard: enter text → **Submit job**, or use **Quick submit**. |
| Retry failed/DLQ job | Click **Retry** on the job row (if endpoint exists). |
| Run tests | `cd backend && npm test` (API must be running). |
| Change port | `PORT=8001 npm start` in backend. |
