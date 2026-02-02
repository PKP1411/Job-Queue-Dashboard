/**
 * Configuration from environment. Copy .env.example to .env to override.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

module.exports = {
  PORT: parseInt(process.env.PORT || '8000', 10),
  API_KEY: process.env.API_KEY || null, // optional; if set, requests must send X-API-Key
  MAX_CONCURRENT_PER_TENANT: parseInt(process.env.RATE_LIMIT_CONCURRENT || '5', 10),
  MAX_NEW_JOBS_PER_MINUTE: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '10', 10),
  LEASE_TIMEOUT_SEC: parseInt(process.env.LEASE_TIMEOUT_SEC || '300', 10), // 5 min; stale jobs re-queued
  POLL_MS: parseInt(process.env.WORKER_POLL_MS || '2000', 10),
  WORKER_CONCURRENCY: Math.min(Math.max(parseInt(process.env.WORKER_CONCURRENCY || '5', 10) || 5, 1), 5), // max 5 jobs at a time
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10),
};
