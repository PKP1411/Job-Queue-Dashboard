/**
 * Simple API tests (correctness: submit, status, idempotency, list).
 * Run: npm test
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const BASE = 'http://localhost:8000';
let serverProcess = null;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : null;
            resolve({ status: res.statusCode, headers: res.headers, data: json });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('Job API', () => {
  it('health returns ok', async () => {
    const res = await request('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data?.status, 'ok');
  });

  it('POST /jobs creates job and GET returns status', async () => {
    const create = await request('POST', '/jobs', { payload: { test: true } });
    assert.strictEqual(create.status, 201);
    assert.ok(create.data?.id);
    assert.strictEqual(create.data?.status, 'pending');

    const get = await request('GET', `/jobs/${create.data.id}`);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.data?.status, create.data.status);
  });

  it('idempotency key returns same job on duplicate submit', async () => {
    const key = 'idem-' + Date.now();
    const first = await request('POST', '/jobs', { payload: {} }, { 'Idempotency-Key': key });
    assert.strictEqual(first.status, 201);
    const id = first.data.id;

    const second = await request('POST', '/jobs', { payload: {} }, { 'Idempotency-Key': key });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.id, id);
  });

  it('GET /jobs returns list, GET /metrics returns counts', async () => {
    const list = await request('GET', '/jobs');
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.data?.jobs));

    const metrics = await request('GET', '/metrics');
    assert.strictEqual(metrics.status, 200);
    assert.ok(typeof metrics.data?.pending === 'number');
    assert.ok(typeof metrics.data?.dlq_count === 'number');
  });
});
