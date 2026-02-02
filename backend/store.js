/**
 * Store: read/write data from backend/data/jobs.json and backend/data/metrics.json.
 * Initially there are no records (empty jobs and dlq; metrics at zero). Data grows as users submit and worker processes.
 */
const path = require('path');
const fs = require('fs');

const DIR = path.resolve(__dirname);
const DATA_DIR = path.join(DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'jobs.json');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');
const RATELIMIT_FILE = path.join(DATA_DIR, 'ratelimit.json');

const DEFAULT_DATA = { jobs: [], dlq: [] };
const DEFAULT_METRICS = { jobs_submitted: 0, jobs_done: 0, jobs_failed: 0, retries: 0 };

const MAX_IDEMPOTENCY_KEY_LEN = 256;

/** Max file size to read (avoid DoS from huge/corrupted file). 50MB so all job history can be stored. */
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Max length for job id / lookup (prevent abuse). */
const MAX_ID_LEN = 256;

/** Sanitize job id for lookups: string, max length, no control chars. */
function sanitizeJobId(id) {
  if (id == null || typeof id !== 'string') return null;
  const s = id.slice(0, MAX_ID_LEN).replace(/[\x00-\x1f\x7f]/g, '');
  return s.length > 0 ? s : null;
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const stat = fs.statSync(DATA_FILE);
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        console.error('store load error: file too large');
        return { jobs: [...DEFAULT_DATA.jobs], dlq: [...DEFAULT_DATA.dlq] };
      }
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data.jobs)) data.jobs = [];
      if (!Array.isArray(data.dlq)) data.dlq = [];
      return data;
    }
  } catch (e) {
    console.error('store load error:', e.message);
  }
  return { jobs: [...DEFAULT_DATA.jobs], dlq: [...DEFAULT_DATA.dlq] };
}

/** Save all jobs and DLQ items — no trimming; full job history is kept in jobs.json. */
function save(data) {
  try {
    const out = {
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
      dlq: Array.isArray(data.dlq) ? data.dlq : [],
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    console.error('store save error:', e.message);
  }
}

function getData() {
  return load();
}

function setData(data) {
  save(data);
}

// --- Jobs
function getJob(id) {
  const sid = sanitizeJobId(id);
  if (!sid) return null;
  const data = load();
  return data.jobs.find((j) => j.id === sid) || null;
}

function getJobs(status, limit = 1000, offset = 0) {
  const data = load();
  let list = data.jobs;
  if (status) list = list.filter((j) => j.status === status);
  list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  return list.slice(off, off + lim);
}

/** Jobs in "running" state whose lease (leased_at) is older than maxAgeMs. Used to re-queue stuck jobs. */
function getStaleRunningJobs(maxAgeMs) {
  const data = load();
  const now = Date.now();
  return data.jobs.filter((j) => {
    if (j.status !== 'running' || !j.leased_at) return false;
    const leasedAt = new Date(j.leased_at).getTime();
    return now - leasedAt > maxAgeMs;
  });
}

function releaseStaleJob(id) {
  const sid = sanitizeJobId(id);
  if (!sid) return null;
  return updateJob(sid, {
    status: 'pending',
    leased_at: null,
    updated_at: new Date().toISOString(),
  });
}

function createJob(job) {
  const data = load();
  data.jobs.push(job);
  save(data);
  return job;
}

function updateJob(id, updates) {
  const sid = sanitizeJobId(id);
  if (!sid) return null;
  const data = load();
  const i = data.jobs.findIndex((j) => j.id === sid);
  if (i === -1) return null;
  data.jobs[i] = { ...data.jobs[i], ...updates };
  save(data);
  return data.jobs[i];
}

function countByStatus(status) {
  const data = load();
  return data.jobs.filter((j) => j.status === status).length;
}

function countRunningByTenant(tenantId) {
  if (tenantId == null || typeof tenantId !== 'string' || tenantId.length > MAX_ID_LEN) return 0;
  const data = load();
  return data.jobs.filter((j) => j.tenant_id === tenantId && j.status === 'running').length;
}

function findJobByIdempotencyKey(key) {
  if (key == null || typeof key !== 'string' || key.length > MAX_IDEMPOTENCY_KEY_LEN) return null;
  const data = load();
  return data.jobs.find((j) => j.idempotency_key === key) || null;
}

/** Oldest pending job first (FIFO). */
function getNextPendingJob() {
  const data = load();
  const pending = data.jobs.filter((j) => j.status === 'pending');
  if (pending.length === 0) return null;
  pending.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return pending[0];
}

// --- DLQ
function listDlq() {
  const data = load();
  return data.dlq.sort((a, b) => new Date(b.failed_at) - new Date(a.failed_at));
}

function addToDlq(item) {
  const data = load();
  data.dlq.push(item);
  save(data);
  return item;
}

function getDlqCount() {
  const data = load();
  return data.dlq.length;
}

// --- Metrics (persisted in data/metrics.json so counts survive restart; API and worker both update)
function loadMetrics() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(METRICS_FILE)) {
      const raw = fs.readFileSync(METRICS_FILE, 'utf8');
      const m = JSON.parse(raw);
      return {
        jobs_submitted: Number(m.jobs_submitted) || 0,
        jobs_done: Number(m.jobs_done) || 0,
        jobs_failed: Number(m.jobs_failed) || 0,
        retries: Number(m.retries) || 0,
      };
    }
  } catch (e) {
    console.error('store loadMetrics error:', e.message);
  }
  return { ...DEFAULT_METRICS };
}

function saveMetrics(metrics) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), 'utf8');
  } catch (e) {
    console.error('store saveMetrics error:', e.message);
  }
}

function getMetrics() {
  return loadMetrics();
}

function incrementJobSubmitted() {
  const m = loadMetrics();
  m.jobs_submitted = (m.jobs_submitted || 0) + 1;
  saveMetrics(m);
  return m;
}

function incrementJobDone() {
  const m = loadMetrics();
  m.jobs_done = (m.jobs_done || 0) + 1;
  saveMetrics(m);
  return m;
}

function incrementJobFailed() {
  const m = loadMetrics();
  m.jobs_failed = (m.jobs_failed || 0) + 1;
  saveMetrics(m);
  return m;
}

function incrementRetries() {
  const m = loadMetrics();
  m.retries = (m.retries || 0) + 1;
  saveMetrics(m);
  return m;
}

// --- Rate limit (persisted so max N jobs per minute per tenant is enforced across restarts)
const RATE_LIMIT_WINDOW_SEC = 60;

function loadRateLimit() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(RATELIMIT_FILE)) {
      const raw = fs.readFileSync(RATELIMIT_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('store loadRateLimit error:', e.message);
  }
  return {};
}

function saveRateLimit(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RATELIMIT_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('store saveRateLimit error:', e.message);
  }
}

/** Returns true if tenant has fewer than maxPerMinute submissions in the last 60 seconds. */
function canSubmitJob(tenantId, maxPerMinute) {
  if (!tenantId || typeof tenantId !== 'string' || tenantId.length > MAX_ID_LEN) return true;
  const data = loadRateLimit();
  const now = Math.floor(Date.now() / 1000);
  const list = (data[tenantId] || []).filter((t) => now - t < RATE_LIMIT_WINDOW_SEC);
  return list.length < maxPerMinute;
}

/** Record a new job submission for tenant (call after canSubmitJob returns true). */
function addRateLimitTimestamp(tenantId) {
  if (!tenantId || typeof tenantId !== 'string' || tenantId.length > MAX_ID_LEN) return;
  const data = loadRateLimit();
  const now = Math.floor(Date.now() / 1000);
  if (!data[tenantId]) data[tenantId] = [];
  data[tenantId] = data[tenantId].filter((t) => now - t < RATE_LIMIT_WINDOW_SEC);
  data[tenantId].push(now);
  saveRateLimit(data);
}

module.exports = {
  getData,
  setData,
  getJob,
  getJobs,
  createJob,
  updateJob,
  countByStatus,
  countRunningByTenant,
  findJobByIdempotencyKey,
  getNextPendingJob,
  getStaleRunningJobs,
  releaseStaleJob,
  listDlq,
  addToDlq,
  getDlqCount,
  sanitizeJobId,
  getMetrics,
  incrementJobSubmitted,
  incrementJobDone,
  incrementJobFailed,
  incrementRetries,
  canSubmitJob,
  addRateLimitTimestamp,
  DATA_FILE,
  METRICS_FILE,
  RATELIMIT_FILE,
};
