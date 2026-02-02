# Design Trade-offs & Auto-Scaling Workers

This document covers **brief design trade-offs** and **how auto-scaling workers would work** (described only; not implemented in this prototype).

---

## Design Trade-offs

| Area | Choice | Trade-off |
|------|--------|-----------|
| **Storage** | Single JSON file (`jobs.json`) | No DB server; simple to run and debug. For higher throughput and multi-worker safety, move to a database (e.g. Postgres) or a queue (e.g. Redis) with atomic lease/ack. |
| **Workers** | Single process, in-memory concurrency (e.g. 5 jobs at once) | Easy to operate. To scale out, run multiple worker processes or containers; then lease must be atomic (e.g. DB row lock or queue visibility timeout) so two workers never process the same job. |
| **Live updates** | WebSocket + polling | Real-time when connected; polling as fallback. Slightly more moving parts than polling-only; worth it for dashboard UX. |
| **Auth** | Optional API key (`X-API-Key`) | Satisfies “authenticated users” for the prototype. Production would typically use JWT/OAuth and per-tenant identity. |
| **Lease timeout** | Re-queue “running” jobs after N seconds | Prevents permanent blockage if a worker dies. Trade-off: timeout too short risks duplicate work; too long delays recovery. |
| **Rate limits** | In-memory per tenant (concurrent + per-minute) | Simple and correct for a single API instance. For multiple API replicas, use a shared store (e.g. Redis) for counters. |
| **Idempotency** | Key in header, lookup in same store as jobs | Prevents duplicate job creation on retries. For cross-replica idempotency, key store must be shared. |

---

## Auto-Scaling Workers (How It Would Work)

The current prototype runs a fixed number of worker processes. **Auto-scaling** would add or remove worker capacity based on load. Below is a description of how that could work; no code is implemented for it here.

### Goals

- **Scale up** when there are many pending jobs (or high utilization).
- **Scale down** when the queue is empty or underutilized to save cost.
- **Avoid** double-processing: only one worker should ever process a given job (already ensured by “lease” semantics if the store supports atomic lease).

### Signals to Use

1. **Pending count** — Number of jobs with `status: 'pending'`. High value ⇒ need more workers.
2. **Throughput / latency** — Jobs completed per minute or time from submit to done. Can drive scale-up if latency is too high.
3. **Worker utilization** — Fraction of time workers are busy (e.g. running jobs vs idle polling). Low utilization ⇒ candidate for scale-down.

These can be obtained from the existing **GET /metrics** (e.g. `pending`, `running`) and from logs or extra metrics (e.g. acks per minute).

### Scaling Model

- **Scale unit**: One worker process (or one container/pod). Each worker can run with the same `WORKER_CONCURRENCY` (e.g. 5) so “N workers” ⇒ up to N × 5 jobs in progress.
- **Scale up**: When `pending` (or a smoothed value) exceeds a threshold (e.g. > 10), or when utilization is high, the controller starts additional workers.
- **Scale down**: When `pending` is 0 (or low) and utilization is low for a cooldown period, the controller stops some workers. To avoid thrashing, use a minimum stable time and hysteresis (e.g. scale down only after pending has been low for 2–5 minutes).

### Who Does the Scaling (Controller)

- **Option A — External**: An orchestrator (e.g. Kubernetes HPA, or a small “scaler” service) periodically calls `GET /metrics`, then starts or stops worker processes/containers. Workers and API stay unchanged; scaling logic lives entirely in the orchestrator.
- **Option B — Internal**: A “supervisor” process in the same codebase that reads metrics (or the store), then spawns or kills worker child processes. Same idea as Option A but bundled with the app.

In both cases, workers must be stateless and get work only from the shared store (e.g. `jobs.json` or a DB). The existing **lease** design (one job leased by one worker at a time) is what prevents double-processing once the store supports atomic lease (e.g. DB row update with `WHERE status = 'pending'`).

### Safety and Operational Notes

- **Graceful shutdown**: On scale-down, workers should finish current jobs (or release leases) before exiting so jobs are re-queued by lease timeout instead of lost.
- **Lease timeout**: Keeps behavior correct if a worker is killed before ack: the job eventually becomes pending again and another worker can take it.
- **Rate limits**: Per-tenant limits (e.g. 5 concurrent, 10/min) are enforced at the API; auto-scaling workers does not change those limits.

### Summary

Auto-scaling workers would: (1) use metrics such as `pending` and utilization, (2) add or remove worker processes/containers via a controller or orchestrator, (3) rely on existing lease/ack and lease-timeout behavior to avoid double-processing and handle failures. Implementation would be outside this prototype (e.g. in Kubernetes or a small scaler service).

---

For **implementation details** (what is built and where), see [IMPLEMENTATION.md](./IMPLEMENTATION.md). For **setup and usage**, see [README.md](./README.md).
