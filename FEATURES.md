# Feature Highlights (Interview Quick Reference)

Use this as a **one-page cheat sheet** when presenting or discussing the project.

---

## 🎯 Core Requirements (All Met)

1. **Job API** — REST: submit job, check status, list jobs. Optional idempotency key.
2. **Persistence** — File-backed `jobs.json`; jobs survive restarts.
3. **Workers** — Lease → process → ack or retry → DLQ after max retries.
4. **Rate limits** — Per-tenant: 5 concurrent jobs, 10 new jobs/minute.
5. **Dashboard** — React UI: Pending / Running / Done / Failed / DLQ; live updates.
6. **Observability** — Structured logs (jobId, traceId), `/metrics`, `/health`.

---

## ⭐ Beyond Requirements (Talking Points)

| Feature | One-line pitch |
|--------|-----------------|
| **WebSocket real-time** | “Dashboard updates instantly when a job changes — no refresh. Worker notifies API after each lease/ack/retry/DLQ; API broadcasts to all connected clients.” |
| **Retry from UI** | “Failed and DLQ jobs have a Retry button. It creates a new job with the same payload so we can re-queue without re-entering data — operational recovery.” |
| **Text-based jobs, 1 sec/char** | “User enters plain text; processing time = 1 second per character so you can watch pending → running → done in real time during the demo.” |
| **Lease timeout** | “If a worker dies while holding a job, we re-queue ‘running’ jobs after 5 minutes so the queue doesn’t block forever.” |
| **Trace ID** | “Every request gets or carries an X-Trace-Id; logs include it for request correlation and debugging.” |
| **Optional API key** | “Supports ‘authenticated users’ via X-API-Key; dashboard can send it; backend enforces it when API_KEY is set in .env.” |
| **Pagination** | “GET /jobs supports limit and offset for large lists.” |
| **Tests** | “`npm test` runs health, submit, get, idempotency, list, metrics — API must be running.” |

---

## 📋 Demo Flow (Step by Step)

1. **Start** — API (`npm start`), worker (`npm run worker`), frontend (`npm run dev`). Open http://localhost:5173.
2. **Submit** — Type “Hello” (5 chars) and click **Submit job**, or click **5 sec** quick submit.
3. **Watch** — Job appears in Pending → moves to Running (pulse) → Done. Updates appear without refresh (WebSocket + polling).
4. **Fail** — Click **Fail (→ DLQ)**; job fails and moves to DLQ after retries.
5. **Retry** — Click **Retry** on the failed/DLQ row; new job is created and processed again.
6. **Metrics** — Show `/metrics` or the dashboard metrics strip (pending, running, done, failed, DLQ count).

---

## 🔗 Key Endpoints

- `POST /jobs` — Submit (body: `{ "text": "..." }` or `{ "payload": {...} }`)
- `POST /jobs/:id/retry` — Retry failed/DLQ job (new job, same payload)
- `GET /jobs`, `GET /jobs/:id` — List and get job
- `GET /dlq` — Dead letter queue
- `GET /metrics` — Counts
- `GET /health` — Health check
- WebSocket `/ws` — Real-time refresh events

---

## 📁 Key Files

- **backend/main.js** — API, WebSocket server, retry endpoint
- **backend/worker.js** — Lease, process (1 sec/char), ack, retry, DLQ, notify API
- **backend/store.js** — Read/write jobs.json
- **frontend/src/App.jsx** — Dashboard, submit, retry button, WebSocket connection
