# Distributed Task Queue & Job Processor

A **distributed job queue** with REST API, worker, and React dashboard. Jobs are stored in `backend/data/jobs.json`; the worker processes up to **5 jobs at a time** (lease → ack or retry → DLQ after max retries).

---

## Start the project

### Prerequisites

- **Node.js** 18+ (or 20 LTS)
- Three terminals (API, worker, frontend)

### 1. Clone and go to the project

```bash
cd "/path/to/Nurix AI Project by Prakash Kumar"
```

### 2. Backend: install and start API

```bash
cd backend
npm install
npm start
```

Wait for: `API running at http://localhost:8000`. Leave this terminal open.

### 3. Worker: start the job processor (new terminal)

```bash
cd backend
npm run worker
```

Worker polls for pending jobs and processes up to 5 at a time.

### 4. Frontend: install and start dashboard (new terminal)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser. You’ll see the Job Queue Dashboard (metrics, submit form, job list, DLQ).

### 5. Try it

1. Enter text (e.g. `Hello`) in **Text to process** and click **Submit job**, or use a quick button.
2. Watch the job go **Pending → Running → Done** (or **Failed** / **DLQ** after retries).

---

## How it works

1. **Submit** — You submit a job from the dashboard (or `POST /jobs`). The API writes it to `backend/data/jobs.json` with status `pending`.
2. **Queue** — Pending jobs sit in the file. The worker polls and picks the **oldest** pending job (FIFO).
3. **Process** — Worker **leases** up to 5 jobs (sets status to `running`), runs each (e.g. 1 second per character of text). When done it **acks** (status → `done`) or **retries** (back to `pending`). After max retries it moves the job to the **Dead Letter Queue (DLQ)**.
4. **Dashboard** — The UI polls the API and shows Pending / Running / Done / Failed and DLQ. You can **retry** a failed or DLQ job from the UI (creates a new job with the same payload).

**Concurrency:** At most **5** jobs run at once. When one finishes, the next pending job is leased automatically.

**Persistence:** All jobs and DLQ are in `backend/data/jobs.json`; metrics in `backend/data/metrics.json`. Data survives restarts.

**More detail** — Features, API reference, config, architecture, security: see **[IMPLEMENTATION.md](./IMPLEMENTATION.md)**.
