/**
 * REST API for the distributed job queue.
 * Features: auth (optional API key), trace ID, health, pagination, rate limits, idempotency.
 * Data: backend/data/jobs.json (file-backed store).
 */
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const logger = require('./logger');
const config = require('./config');

const app = express();

// --- Security: limit CORS and body size
app.use(cors({ origin: true, credentials: false })); // restrict in production to known origins
app.use(express.json({ limit: '100kb' }));

// --- Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// --- Trace ID: use X-Trace-Id from client or generate (for observability)
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4().slice(0, 8);
  res.setHeader('X-Trace-Id', req.traceId);
  next();
});

// --- Optional API key auth (constant-time compare to prevent timing attacks)
app.use((req, res, next) => {
  if (!config.API_KEY) return next();
  const key = String(req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '');
  const expected = String(config.API_KEY);
  if (key.length !== expected.length) {
    logger.warn('auth_failed', { traceId: req.traceId, message: 'Invalid or missing API key' });
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(key, 'utf8'), Buffer.from(expected, 'utf8'))) {
      logger.warn('auth_failed', { traceId: req.traceId, message: 'Invalid or missing API key' });
      return res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
});

const MAX_TENANT_ID_LEN = 128;
const MAX_IDEMPOTENCY_KEY_LEN = 256;
const ALLOWED_STATUSES = new Set(['pending', 'running', 'done', 'failed']);

function getTenant(req) {
  const raw = req.headers['x-tenant-id'] || 'default';
  const s = String(raw).slice(0, MAX_TENANT_ID_LEN);
  return /^[\w.-]*$/.test(s) ? s : 'default';
}

/** Rate limit: max N new jobs per minute per tenant (persisted in data/ratelimit.json). Call recordRateLimit(tenantId) only after creating a new job. */
function checkRate(tenantId) {
  if (!store.canSubmitJob(tenantId, config.MAX_NEW_JOBS_PER_MINUTE)) {
    const err = new Error(`Max ${config.MAX_NEW_JOBS_PER_MINUTE} new jobs per minute per tenant`);
    err.status = 429;
    throw err;
  }
}

/** Sanitize payload: only allow known keys to prevent prototype pollution. */
function sanitizePayload(obj) {
  if (obj === null || typeof obj !== 'object') return {};
  const out = {};
  const allowed = ['text', 'fail', 'invalid'];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function rowToJob(row) {
  let payload = null;
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload);
      payload = typeof parsed === 'object' && parsed !== null ? parsed : { text: String(parsed) };
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    status: row.status,
    payload,
    retries: row.retries,
    max_retries: row.max_retries,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    leased_at: row.leased_at,
    completed_at: row.completed_at,
    result: row.result,
    error_message: row.error_message,
  };
}

// --- Health check (for probes and monitoring)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// --- Submit job (accepts { text: "..." } or { payload: {...} }; backend normalizes to payload)
app.post('/jobs', (req, res) => {
  const tenantId = getTenant(req);
  const rawKey = req.headers['idempotency-key'];
  const idempotencyKey = rawKey != null ? String(rawKey).slice(0, MAX_IDEMPOTENCY_KEY_LEN) || null : null;
  const rawPayload = req.body?.text !== undefined
    ? { text: String(req.body.text) }
    : (req.body?.payload ?? {});
  const payload = sanitizePayload(rawPayload);

  try {
    checkRate(tenantId);
  } catch (e) {
    logger.warn('rate_limit', { traceId: req.traceId, tenantId, message: e.message });
    return res.status(e.status || 429).json({ error: e.message });
  }

  const now = new Date().toISOString();
  if (idempotencyKey) {
    const existing = store.findJobByIdempotencyKey(idempotencyKey);
    if (existing) {
      logger.info('submit_idempotent', { traceId: req.traceId, jobId: existing.id, tenantId });
      return res.json(rowToJob(existing));
    }
  }

  const jobId = uuidv4();
  const job = {
    id: jobId,
    status: 'pending',
    payload: JSON.stringify(payload),
    retries: 0,
    max_retries: config.MAX_RETRIES,
    idempotency_key: idempotencyKey,
    tenant_id: tenantId,
    created_at: now,
    updated_at: now,
    leased_at: null,
    completed_at: null,
    result: null,
    error_message: null,
  };
  store.createJob(job);
  store.addRateLimitTimestamp(tenantId);
  store.incrementJobSubmitted();
  logger.info('submit', { traceId: req.traceId, jobId, tenantId });
  res.status(201).json(rowToJob(job));
});

// --- Get job by ID (validate id format to prevent abuse)
app.get('/jobs/:id', (req, res) => {
  const id = store.sanitizeJobId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid job id' });
  const row = store.getJob(id);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  res.json(rowToJob(row));
});

// --- List jobs (with pagination; validate status, limit, offset)
app.get('/jobs', (req, res) => {
  const rawStatus = req.query.status;
  const status = rawStatus && ALLOWED_STATUSES.has(String(rawStatus)) ? String(rawStatus) : null;
  const limit = Math.min(Math.max(1, parseInt(req.query.limit || '100', 10) || 100), 500);
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
  const rows = store.getJobs(status, limit, offset);
  res.json({ jobs: rows.map(rowToJob), limit, offset });
});

// --- DLQ
app.get('/dlq', (req, res) => {
  const items = store.listDlq();
  res.json({ items });
});

// --- Metrics (observability; counts persisted in data/metrics.json)
app.get('/metrics', (req, res) => {
  const metrics = store.getMetrics();
  res.json({
    jobs_submitted: metrics.jobs_submitted,
    jobs_done: metrics.jobs_done,
    jobs_failed: metrics.jobs_failed,
    retries: metrics.retries,
    pending: store.countByStatus('pending'),
    running: store.countByStatus('running'),
    done: store.countByStatus('done'),
    failed: store.countByStatus('failed'),
    dlq_count: store.getDlqCount(),
  });
});

// --- Error handler (do not leak internal details to client)
app.use((err, req, res, next) => {
  logger.error('request_error', { traceId: req?.traceId, error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = config.PORT;
logger.info('start', { message: `Data file: ${store.DATA_FILE}`, port: PORT });
const server = app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or run with PORT=${PORT + 1} npm start`);
    process.exit(1);
  }
  throw err;
});
