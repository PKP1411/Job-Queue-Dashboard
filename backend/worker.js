/**
 * Worker: at most 5 jobs run at once (WORKER_CONCURRENCY capped at 5). FIFO pending order.
 * Lease timeout: stuck "running" jobs are re-queued after LEASE_TIMEOUT_SEC.
 */
const store = require('./store');
const logger = require('./logger');
const config = require('./config');

const POLL_MS = config.POLL_MS;
const MAX_RETRIES = config.MAX_RETRIES;
const LEASE_TIMEOUT_MS = config.LEASE_TIMEOUT_SEC * 1000;
const WORKER_CONCURRENCY = config.WORKER_CONCURRENCY;

/** Number of jobs currently being processed (in flight). */
let inFlight = 0;

/** Simulate work: 1 second per character of payload.text (min 1s, max 30s). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Max allowed text length; jobs with more characters fail and go to DLQ after retries. */
const MAX_TEXT_LENGTH = 30;

/**
 * Process job with multiple possible failure reasons (for DLQ demo / interview):
 * - payload.fail === true → Simulated failure for testing
 * - text length > 30 → Text length exceeds maximum (30 characters)
 * - empty/missing text → Payload must include non-empty text
 * - text contains "reject" → Job rejected: forbidden content
 * - payload.invalid === true → Invalid payload format
 */
async function processJob(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload: must be an object');
  }
  if (payload.invalid === true) {
    throw new Error('Invalid payload format (invalid=true)');
  }
  if (payload.fail === true) {
    throw new Error('Simulated failure for testing');
  }

  const text = payload.text !== undefined ? String(payload.text) : '';
  if (!text || !text.trim()) {
    throw new Error('Payload must include non-empty text');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Text length exceeds maximum (${text.length} > ${MAX_TEXT_LENGTH} characters)`);
  }
  if (text.toLowerCase().includes('reject')) {
    throw new Error('Job rejected: forbidden content (text contains "reject")');
  }

  const seconds = Math.min(Math.max(text.length, 1), MAX_TEXT_LENGTH);
  await sleep(seconds * 1000);
  return {
    processed: true,
    at: new Date().toISOString(),
    durationSeconds: seconds,
    textLength: text.length,
  };
}

/** Re-queue jobs that have been "running" longer than lease timeout (worker died or stuck). */
function releaseStaleLeases() {
  const stale = store.getStaleRunningJobs(LEASE_TIMEOUT_MS);
  for (const job of stale) {
    store.releaseStaleJob(job.id);
    logger.warn('lease_timeout', { jobId: job.id, message: 'Re-queued stale running job' });
  }
}

function leaseOne() {
  const job = store.getNextPendingJob();
  if (!job) return null;
  const now = new Date().toISOString();
  store.updateJob(job.id, {
    status: 'running',
    updated_at: now,
    leased_at: now,
  });
  const updated = store.getJob(job.id);
  if (updated.status !== 'running') return null;
  logger.info('lease', { jobId: job.id, message: 'started' });
  return updated;
}

function ack(jobId, result) {
  const now = new Date().toISOString();
  store.updateJob(jobId, {
    status: 'done',
    updated_at: now,
    completed_at: now,
    result: JSON.stringify(result || {}),
  });
  store.incrementJobDone();
  logger.info('ack', { jobId, message: 'done' });
}

function retry(jobId, errorMessage) {
  const now = new Date().toISOString();
  const job = store.getJob(jobId);
  store.updateJob(jobId, {
    status: 'pending',
    updated_at: now,
    leased_at: null,
    error_message: errorMessage || null,
    retries: (job.retries || 0) + 1,
  });
  store.incrementRetries();
  logger.info('retry', { jobId, message: errorMessage || '' });
}

function sendToDlq(job, lastError, finalRetries) {
  const now = new Date().toISOString();
  const dlqId = `dlq-${job.id}-${Date.now()}`;
  store.addToDlq({
    id: dlqId,
    job_id: job.id,
    payload: job.payload,
    retries: finalRetries ?? job.retries,
    last_error: lastError || 'Max retries exceeded',
    failed_at: now,
    tenant_id: job.tenant_id,
  });
  store.updateJob(job.id, {
    status: 'failed',
    updated_at: now,
    completed_at: now,
    error_message: lastError || 'Moved to DLQ after max retries',
  });
  store.incrementJobFailed();
  logger.info('dlq', { jobId: job.id, message: 'moved to DLQ' });
}

/** Process one already-leased job (ack, retry, or send to DLQ). Does not lease. */
async function runOneJob(job) {
  let payload = {};
  if (job.payload) {
    try {
      const parsed = JSON.parse(job.payload);
      payload = typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (e) {
      logger.warn('job_failed', { jobId: job.id, error: 'Invalid job payload JSON' });
      sendToDlq(job, 'Invalid job payload JSON', (job.retries || 0) + 1);
      return;
    }
  }
  const currentRetries = (job.retries || 0) + 1;

  try {
    const result = await processJob(payload);
    ack(job.id, result);
  } catch (err) {
    const errMsg = err.message || 'Unknown error';
    logger.warn('job_failed', { jobId: job.id, error: errMsg });
    if (currentRetries >= (job.max_retries || MAX_RETRIES)) {
      store.updateJob(job.id, { error_message: errMsg });
      sendToDlq(job, errMsg, currentRetries);
    } else {
      retry(job.id, errMsg);
    }
  }
}

/** Release stale leases, then fill concurrency slots up to WORKER_CONCURRENCY. */
function tryLeaseAndStart() {
  releaseStaleLeases();
  while (inFlight < WORKER_CONCURRENCY) {
    const job = leaseOne();
    if (!job) break;
    inFlight += 1;
    runOneJob(job).finally(() => {
      inFlight -= 1;
      tryLeaseAndStart(); // refill slot as soon as one finishes
    });
  }
}

// Start: fill concurrency pool and re-check periodically for new pending jobs
tryLeaseAndStart();
setInterval(tryLeaseAndStart, POLL_MS);

logger.info('worker_start', {
  message: 'worker started',
  leaseTimeoutSec: config.LEASE_TIMEOUT_SEC,
  concurrency: WORKER_CONCURRENCY,
});
