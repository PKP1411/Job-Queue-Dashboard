/**
 * API client for job queue backend (http://localhost:8000).
 * In dev, Vite proxies /api → backend.
 * Optional: pass apiKey in options to authenticate (X-API-Key).
 */
const BASE = '/api';

function defaultHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  return headers;
}

export async function healthCheck() {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) return null;
  return res.json();
}

/** Submit job. Pass a string for text-based jobs (1 sec per char), or { text: "..." } or { payload: {...} }. */
export async function submitJob(payloadOrText, options = {}) {
  const { idempotencyKey, tenantId, apiKey } = options;
  const headers = defaultHeaders();
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (apiKey) headers['X-API-Key'] = apiKey;
  const body =
    typeof payloadOrText === 'string'
      ? { text: payloadOrText }
      : payloadOrText && payloadOrText.text !== undefined
        ? { text: payloadOrText.text }
        : { payload: payloadOrText ?? {} };
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function getJob(id, options = {}) {
  const headers = options.apiKey ? { 'X-API-Key': options.apiKey } : {};
  const res = await fetch(`${BASE}/jobs/${id}`, { headers });
  if (!res.ok) throw new Error('Job not found');
  return res.json();
}

export async function listJobs(status, options = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  const url = `${BASE}/jobs${params.toString() ? '?' + params : ''}`;
  const headers = options.apiKey ? { 'X-API-Key': options.apiKey } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('Failed to fetch jobs');
  const data = await res.json();
  return data.jobs || [];
}

export async function listDlq(options = {}) {
  const headers = options.apiKey ? { 'X-API-Key': options.apiKey } : {};
  const res = await fetch(`${BASE}/dlq`, { headers });
  if (!res.ok) throw new Error('Failed to fetch DLQ');
  const data = await res.json();
  return data.items || [];
}

export async function getMetrics(options = {}) {
  const headers = options.apiKey ? { 'X-API-Key': options.apiKey } : {};
  const res = await fetch(`${BASE}/metrics`, { headers });
  if (!res.ok) throw new Error('Failed to fetch metrics');
  return res.json();
}
