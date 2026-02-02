# Distributed Task Queue & Job Processor

**A prototype-grade distributed job queue** with REST API, worker nodes, real-time dashboard, and file-backed persistence. Built for reliability, observability, and operational recovery.

---

## ✨ Highlighted Features

### Core (Requirements)

| Feature | What it does |
|--------|----------------|
| **REST Job API** | Submit jobs (`POST /jobs`), check status (`GET /jobs/:id`), list by status. Optional **idempotency key** to avoid duplicate submissions. |
| **Persistence** | All jobs and DLQ items in `backend/data/jobs.json`; metrics in `backend/data/metrics.json`. **Initially there are no records**; data is added as you submit jobs and the worker processes. Full history kept — no trimming. Survives restarts. |
| **Worker: Lease → Ack → Retry → DLQ** | Workers **lease up to 5 jobs concurrently** (configurable), process each, then **ack** (done) or **retry** (re-queue). After max retries, job moves to **Dead Letter Queue (DLQ)**. |
| **Rate limits & quotas** | Per-tenant: **10 new jobs per minute** (rate only). New jobs are always accepted and **wait in queue**; worker processes up to 5 at a time, so when one completes the next pending job runs automatically. No “max 5 concurrent” error. |
| **Dashboard (React)** | View **Pending / Running / Done / Failed** jobs and **DLQ**. Submit jobs and see status. |
| **Observability** | **Structured JSON logs** (event, jobId, traceId). **GET /metrics** (counts). **GET /health** (uptime). |

### Beyond Requirements (Interview Differentiators)

| Feature | Why it stands out |
|--------|--------------------|
| **WebSocket real-time updates** | Dashboard updates **instantly** when a job changes (lease, ack, retry, DLQ). No refresh; shows “● Live” when connected. |
| **Retry failed/DLQ jobs from UI** | **Retry** button on failed jobs and DLQ rows. Creates a **new job with the same payload** — operational recovery without re-entering data. |
| **Text-based jobs, 1 sec per character** | Submit **plain text**; backend handles it. Processing time = **1 second per character** (min 1s, max 30s) so you can **watch jobs move pending → running → done** in real time. |
| **Lease timeout** | If a worker dies while holding a job, **stuck “running” jobs are re-queued** after 5 minutes so the queue doesn’t block forever. |
| **Optional API key auth** | “Authenticated users” via **X-API-Key**. Set `API_KEY` in `.env` to enforce; dashboard has an optional API key field. |
| **Trace ID on every request** | Every API response includes **X-Trace-Id**; logs include it for **request correlation** and debugging. |
| **Pagination** | `GET /jobs?limit=20&offset=0` for large lists. |
| **Simple tests** | `npm test` in backend runs **health, submit, get, idempotency, list, metrics** checks. |

---

## 📋 Step-by-Step: Setup & Run

### Prerequisites

- **Node.js** 18+ (or 20 LTS recommended)
- Three terminals (or one for API, one for worker, one for frontend)

### Step 1: Clone / open the project

```bash
cd "/path/to/Nurix AI Project by Prakash Kumar"
```

### Step 2: Install backend dependencies

```bash
cd backend
npm install
```

### Step 3: Start the API server

```bash
npm start
```

Wait until you see:

```text
API running at http://localhost:8000 (WebSocket: /ws)
```

Leave this terminal open. The API serves REST and WebSocket on port **8000**.

### Step 4: Start the worker (new terminal)

```bash
cd backend
npm run worker
```

You should see:

```text
{"ts":"...","level":"info","event":"worker_start","message":"worker started",...}
```

The worker will poll for pending jobs and process them (lease → process → ack or retry → DLQ).

### Step 5: Install and start the frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
```

When Vite is ready, open:

```text
http://localhost:5173
```

You should see the **Job Queue Dashboard** with metrics, submit form, job list, and DLQ.

### Step 6: Verify end-to-end

1. In the dashboard, type some text (e.g. `Hello`) in **Text to process** and click **Submit job**, or use a quick button (e.g. **5 sec**).
2. Watch the job appear in **Pending**, then move to **Running** (with a pulse), then **Done** — without refreshing. Updates come from **WebSocket** and polling.
3. Optionally submit **Fail (→ DLQ)** to see a job fail and move to DLQ, then use **Retry** on that row to re-queue it.

---

## 📋 Step-by-Step: Using the Dashboard

### Submitting a job

1. **Text to process** — Enter any text. Processing time = **1 second per character** (e.g. `Hello` = 5 seconds).
2. Click **Submit job**.
3. Or use **Quick submit**: **2 sec**, **5 sec**, **11 sec**, **30 sec (max)**, **>30 chars (→ DLQ)** (length limit), or **Fail (→ DLQ)** (simulated failure).

### Watching jobs in real time

- **Pending** — Waiting for a worker.
- **Running** — Worker is processing (row pulses). Duration = length of the text in seconds.
- **Done** — Completed successfully.
- **Failed** — Failed after max retries; may appear in **DLQ** as well.

The dashboard updates via **WebSocket** when the worker leases, acks, retries, or moves a job to DLQ. It also polls every 0.8s when there are active jobs.

### Retrying a failed or DLQ job

1. Find the job in **Failed** or in **Dead letter queue**.
2. Click the **Retry** button on that row.
3. A **new job** with the same payload is created and appears in **Pending**; the worker will process it again.

### DLQ failure reasons (for interview / demo)

Jobs move to the **Dead Letter Queue** after **max retries** when the worker throws an error. Each DLQ item stores **last_error** (the failure reason). Supported failure reasons:

| Reason | How to trigger | Example message |
|--------|----------------|-----------------|
| **Text length > 30** | Submit text with more than 30 characters | `Text length exceeds maximum (31 > 30 characters)` |
| **Simulated failure** | Quick submit **Fail (→ DLQ)** or payload `{ "fail": true }` | `Simulated failure for testing` |
| **Empty text** | Submit with empty or missing text | `Payload must include non-empty text` |
| **Forbidden content** | Text contains the word `reject` | `Job rejected: forbidden content (text contains "reject")` |
| **Invalid payload** | Payload `{ "invalid": true }` | `Invalid payload format (invalid=true)` |

Use **Quick submit**: **>30 chars (→ DLQ)** to demo the length limit; **Fail (→ DLQ)** for simulated failure. The DLQ row shows the **reason** (last error) so you can explain retry vs DLQ logic in an interview.

### Optional: API key and tenant

- **API key** — If the backend has `API_KEY` set in `.env`, enter it in the dashboard so requests are authenticated.
- **Tenant ID** — Optional header for multi-tenant rate limits (default: `default`).

---

## 🏗 Architecture (Step-by-Step Flow)

```
┌─────────────┐     POST /jobs      ┌─────────────┐     read/write     ┌──────────────┐
│  Dashboard  │ ──────────────────► │  API        │ ◄────────────────► │ jobs.json    │
│  (React)    │ ◄── WebSocket ────── │  (Express)   │                    │ (persistence)│
└─────────────┘     + polling       └──────┬──────┘                    └──────────────┘
                                            │
                                            │ GET /internal/notify (after each job update)
                                            │
                                            ▼
                                     ┌─────────────┐     poll + lease   ┌──────────────┐
                                     │  Worker      │ ◄────────────────► │ jobs.json    │
                                     │  (Node)      │     ack / retry    │              │
                                     └─────────────┘     DLQ             └──────────────┘
```

1. **User** submits text (or quick-submit) from the dashboard.
2. **API** validates rate limits, creates a job, writes to **jobs.json**, broadcasts via **WebSocket**, returns job id.
3. **Worker** polls, **leases up to 5 pending jobs** (status → running), notifies API → **WebSocket** broadcast.
4. **Worker** processes each job for **N seconds** (N = text length), then **acks** (status → done) or **retries** (back to pending) or sends to **DLQ** (after max retries). After each step it calls **GET /internal/notify** so the API can broadcast.
5. **Dashboard** receives WebSocket messages and/or polling and refreshes the list so the user sees **pending → running → done** in real time.

---

## 📡 API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check. Returns `{ status: "ok", uptime }`. |
| POST | `/jobs` | Submit job. Body: **`{ "text": "..." }`** (1 sec/char) or `{ "payload": { ... } }`. Headers: `Idempotency-Key`, `X-Tenant-Id`, `X-API-Key` (optional). |
| POST | `/jobs/:id/retry` | **Retry** a failed or DLQ job. Creates a new job with the same payload. |
| GET | `/jobs` | List jobs. Query: `?status=pending|running|done|failed`, `?limit=20`, `?offset=0`. |
| GET | `/jobs/:id` | Get one job by id. |
| GET | `/dlq` | List dead-letter queue items. |
| GET | `/metrics` | Counts: pending, running, done, failed, dlq_count, jobs_submitted, retries. |
| GET | `/internal/notify` | Used by worker to trigger WebSocket broadcast (no auth in prototype). |

**WebSocket:** Connect to `ws://localhost:8000/ws` (or via Vite proxy `/ws`). Server sends JSON messages like `{ "type": "refresh" }` or `{ "type": "job_created", "jobId": "..." }`. Client should refetch jobs/metrics on message.

All HTTP responses include **X-Trace-Id** for correlation.

---

## ⚙️ Configuration (backend)

Copy `backend/.env.example` to `backend/.env` to override:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8000 | API and WebSocket port. |
| `API_KEY` | (none) | If set, clients must send `X-API-Key`. |
| `RATE_LIMIT_CONCURRENT` | 5 | Not used to reject submissions; jobs wait in queue. Kept for compatibility. |
| `RATE_LIMIT_PER_MINUTE` | 10 | Max new jobs per tenant per minute. |
| `LEASE_TIMEOUT_SEC` | 300 | Re-queue “running” jobs after this many seconds (stale lease). |
| `MAX_RETRIES` | 3 | Retries before moving job to DLQ. |
| `WORKER_POLL_MS` | 2000 | Worker poll interval in ms. |
| `WORKER_CONCURRENCY` | 5 | Max jobs processed at once by the worker. |

---

## 📁 Project Structure

```
Nurix AI Project by Prakash Kumar/
├── README.md                 ← This documentation (setup, usage, quick reference)
├── IMPLEMENTATION.md         ← What is implemented and where (flows, files)
├── DESIGN_AND_SCALING.md     ← Auto-scale workers (how it would work) + design trade-offs
├── backend/
│   ├── main.js               ← API + WebSocket server
│   ├── worker.js             ← Job processor (lease / ack / retry / DLQ)
│   ├── store.js              ← File-backed store (jobs.json)
│   ├── config.js             ← Env configuration
│   ├── logger.js             ← Structured JSON logs
│   ├── package.json
│   ├── .env.example
│   ├── data/
│   │   └── jobs.json         ← Persistent jobs + DLQ
│   └── tests/
│       └── api.test.js      ← API tests (npm test)
├── frontend/
│   ├── src/
│   │   ├── App.jsx           ← Dashboard (submit, list, retry, WebSocket)
│   │   ├── api.js            ← API client
│   │   └── App.css
│   ├── index.html
│   └── vite.config.js        ← Proxy /api and /ws to backend
└── db/
    ├── schema.md             ← Schema reference (no SQL executed)
    └── README.md
```

---

## 🧪 Tests

With the **API running** in another terminal:

```bash
cd backend
npm test
```

Covers: health, submit job, get job, idempotency key, list jobs, metrics.

---

## 📐 Implementation & Design

- **Implementation details** — What is built and where (flows, files, config): see **[IMPLEMENTATION.md](./IMPLEMENTATION.md)**.
- **Auto-scale workers** — How auto-scaling workers would work (signals, controller, safety), and **design trade-offs** in more detail: see **[DESIGN_AND_SCALING.md](./DESIGN_AND_SCALING.md)**.

Brief trade-offs:

| Area | Choice | Trade-off |
|------|--------|-----------|
| **Storage** | JSON file | No DB server; simple. For scale, switch to Postgres/Redis with same API. |
| **Workers** | Single process, poll | Easy to run. Scale by running multiple workers; use atomic lease in DB for safety. |
| **Live updates** | WebSocket + polling | Real-time when possible; polling as fallback. |
| **Auth** | Optional API key | Good for “authenticated users” in a prototype; use JWT/OAuth for production. |
| **Lease timeout** | Re-queue stuck jobs | Prevents permanent blockage if worker dies; tune timeout to avoid duplicate work. |

---

## ✅ Evaluation Focus Mapping

| Focus | Where it’s covered |
|-------|--------------------|
| **Correctness** | Lease/ack/retry/DLQ in `worker.js`; idempotency in `main.js`; lease timeout; retry from UI. |
| **Reliability** | Persistence in `jobs.json`; survives restarts; lease timeout; WebSocket + polling for visibility. |
| **API & UX** | REST + WebSocket; dashboard with submit, status tabs, DLQ, **Retry**; real-time updates. |
| **Observability** | Structured logs; `/metrics` and `/health`; trace ID; job ID in logs. |
| **Code quality** | Modular backend; comments; `npm test`; clear README and docs. |

---

## 🔒 Security (hardening)

- **API key:** Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks.
- **Input validation:** Tenant ID and idempotency key length-capped and sanitized; job id validated for lookups; `status` in GET /jobs restricted to allowed values; `limit`/`offset` validated and bounded.
- **Payload:** Only allowed keys (`text`, `fail`, `invalid`) are stored to avoid prototype pollution.
- **Security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- **Error responses:** 500 handler returns a generic message so internal details are not leaked.
- **Store:** Max file size on load (5MB); job id and tenant/idempotency key length limits; safe JSON parse in API and worker.
- **Dependencies:** Run `npm audit` in `backend` and `frontend` and fix reported issues.

---

## 🚀 Quick Reference

| Goal | Command / Action |
|------|------------------|
| Start API | `cd backend && npm start` |
| Start worker | `cd backend && npm run worker` |
| Start dashboard | `cd frontend && npm run dev` → open http://localhost:5173 |
| Submit job | Dashboard: enter text → **Submit job**, or use **Quick submit**. |
| Retry failed/DLQ job | Click **Retry** on the job row. |
| Run tests | `cd backend && npm test` (API must be running). |
| Change port | `PORT=8001 npm start` in backend. |
