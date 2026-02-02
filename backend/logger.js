/**
 * Structured logging with trace ID and job ID for observability.
 */
function log(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data.traceId && { traceId: data.traceId }),
    ...(data.jobId && { jobId: data.jobId }),
    ...(data.tenantId && { tenantId: data.tenantId }),
    ...(data.message && { message: data.message }),
    ...(data.error && { error: data.error }),
  };
  console.log(JSON.stringify(entry));
}

module.exports = {
  info: (event, data) => log('info', event, data),
  warn: (event, data) => log('warn', event, data),
  error: (event, data) => log('error', event, data),
};
