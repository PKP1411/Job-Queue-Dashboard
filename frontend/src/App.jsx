import { useState, useEffect, useCallback } from 'react';
import { submitJob, listJobs, listDlq, getMetrics } from './api';
import './App.css';

const POLL_INTERVAL_MS = 3000;
const POLL_INTERVAL_REALTIME_MS = 800;
const POLL_INTERVAL_WHEN_ERROR_MS = 10000;
const STATUSES = ['pending', 'running', 'done', 'failed'];

function jobText(job) {
  if (!job.payload) return '';
  if (typeof job.payload === 'string') {
    try {
      const p = JSON.parse(job.payload);
      return p?.text ?? p?.message ?? job.payload.slice(0, 50);
    } catch {
      return job.payload.slice(0, 50);
    }
  }
  return job.payload?.text ?? job.payload?.message ?? '';
}

/** Duration in seconds for running job (1 sec per char, min 1 max 30 — matches worker). */
function jobDurationSec(job) {
  const text = jobText(job);
  return Math.min(Math.max((text || '').length, 1), 30);
}

function JobRow({ job }) {
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState(0);
  const text = jobText(job);
  const isRunning = job.status === 'running';
  const durationSec = jobDurationSec(job);
  const leasedAt = job.leased_at ? new Date(job.leased_at).getTime() : null;

  // Progress bar for running jobs: update every 200ms based on elapsed / duration
  useEffect(() => {
    if (!isRunning || !leasedAt) {
      setProgress(0);
      return;
    }
    const tick = () => {
      const elapsed = (Date.now() - leasedAt) / 1000;
      const p = Math.min(100, (elapsed / durationSec) * 100);
      setProgress(p);
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [isRunning, leasedAt, durationSec]);

  return (
    <div className={`job-row status-${job.status} ${isRunning ? 'is-running' : ''}`} onClick={() => setExpanded(!expanded)}>
      <div className="job-row-main">
        <span className="job-status">{job.status}</span>
        {text && <span className="job-text" title={text}>{text.length > 40 ? text.slice(0, 40) + '…' : text}</span>}
        <span className="job-retries">retries: {job.retries}/{job.max_retries}</span>
        <span className="job-time">{new Date(job.created_at).toLocaleString()}</span>
      </div>
      {isRunning && (
        <div className="job-progress-wrap">
          <div className="job-progress" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} title={`${Math.round(progress)}% — ${durationSec}s total`}>
            <div className="job-progress-bar" style={{ width: `${progress}%` }} />
          </div>
          <span className="job-progress-label">{Math.round(progress)}%</span>
        </div>
      )}
      {expanded && (
        <div className="job-row-detail">
          <p><strong>ID:</strong> <code>{job.id}</code></p>
          {job.payload && (
            <p><strong>Payload:</strong> <pre>{typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload, null, 2)}</pre></p>
          )}
          {job.error_message && <p className="error"><strong>Error:</strong> {job.error_message}</p>}
          {job.result && <p><strong>Result:</strong> <pre>{job.result}</pre></p>}
        </div>
      )}
    </div>
  );
}

function DlqRow({ item }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="dlq-row" onClick={() => setExpanded(!expanded)}>
      <div className="job-row-main">
        {item.last_error && <span className="dlq-reason" title={item.last_error}>{item.last_error.length > 50 ? item.last_error.slice(0, 50) + '…' : item.last_error}</span>}
        <span className="job-retries">retries: {item.retries}</span>
        <span className="job-time">{new Date(item.failed_at).toLocaleString()}</span>
      </div>
      {expanded && (
        <div className="job-row-detail">
          <p><strong>Job ID:</strong> <code>{item.job_id}</code></p>
          {item.last_error && <p className="error"><strong>Reason (last error):</strong> {item.last_error}</p>}
          {item.payload && <p><strong>Payload:</strong> <pre>{item.payload}</pre></p>}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [dlq, setDlq] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [textInput, setTextInput] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [tenantId, setTenantId] = useState('default');
  const [apiKey, setApiKey] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [submitStatus, setSubmitStatus] = useState({ type: null, message: '' });
  const [filter, setFilter] = useState('all');

  const fetchData = useCallback(async () => {
    const opts = apiKey ? { apiKey } : {};
    try {
      const [jobsRes, dlqRes, metricsRes] = await Promise.all([
        listJobs(undefined, opts),
        listDlq(opts),
        getMetrics(opts),
      ]);
      setJobs(jobsRes);
      setDlq(dlqRes);
      setMetrics(metricsRes);
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err.message || 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  const hasActiveJobs = (metrics?.pending ?? 0) > 0 || (metrics?.running ?? 0) > 0;
  useEffect(() => {
    fetchData();
    const interval = error
      ? POLL_INTERVAL_WHEN_ERROR_MS
      : hasActiveJobs
        ? POLL_INTERVAL_REALTIME_MS
        : POLL_INTERVAL_MS;
    const id = setInterval(fetchData, interval);
    return () => clearInterval(id);
  }, [fetchData, error, hasActiveJobs]);

  async function handleSubmit(e) {
    e?.preventDefault();
    setSubmitStatus({ type: null, message: '' });
    const text = (textInput || '').trim();
    try {
      await submitJob(text || ' ', {
        idempotencyKey: idempotencyKey || undefined,
        tenantId: tenantId || undefined,
        apiKey: apiKey || undefined,
      });
      setSubmitStatus({ type: 'success', message: 'Job submitted' });
      setTextInput('');
      setIdempotencyKey('');
      fetchData();
    } catch (err) {
      setSubmitStatus({ type: 'error', message: err.message || 'Submit failed' });
    }
  }

  /** One-click submit: text = N chars → N seconds processing. */
  async function quickSubmitText(text) {
    setSubmitStatus({ type: null, message: '' });
    try {
      await submitJob(text, {
        tenantId: tenantId || undefined,
        apiKey: apiKey || undefined,
      });
      setSubmitStatus({ type: 'success', message: 'Job submitted (' + text.length + ' sec)' });
      setTextInput(text);
      fetchData();
    } catch (err) {
      setSubmitStatus({ type: 'error', message: err.message || 'Submit failed' });
    }
  }

  async function quickSubmitFail() {
    setSubmitStatus({ type: null, message: '' });
    try {
      await submitJob({ fail: true }, {
        tenantId: tenantId || undefined,
        apiKey: apiKey || undefined,
      });
      setSubmitStatus({ type: 'success', message: 'Job submitted (will fail → DLQ)' });
      fetchData();
    } catch (err) {
      setSubmitStatus({ type: 'error', message: err.message || 'Submit failed' });
    }
  }

  /** Submit text with 31 chars so worker fails with "Text length exceeds maximum" → DLQ after retries. */
  async function quickSubmitOverLength() {
    const longText = 'This text has exactly thirty-one characters!!';
    setSubmitStatus({ type: null, message: '' });
    try {
      await submitJob({ text: longText }, {
        tenantId: tenantId || undefined,
        apiKey: apiKey || undefined,
      });
      setSubmitStatus({ type: 'success', message: `Job submitted (${longText.length} chars > 30 → will fail → DLQ)` });
      fetchData();
    } catch (err) {
      setSubmitStatus({ type: 'error', message: err.message || 'Submit failed' });
    }
  }

  const filteredJobs = filter === 'all' ? jobs : jobs.filter((j) => j.status === filter);

  return (
    <div className="app">
      <header className="header">
        <h1>Job Queue Dashboard</h1>
        <p className="subtitle">Submit jobs and watch Pending → Running → Done / Failed · DLQ</p>
      </header>

      {error && (
        <div className="banner error">
          Cannot reach API. Start the backend first: in a terminal run <code>cd backend && npm start</code> and wait for &quot;API running at http://localhost:8000&quot;, then refresh this page.
        </div>
      )}

      <section className="metrics">
        {metrics && (
          <div className="metrics-grid">
            <div className="metric"><span className="value">{metrics.pending ?? 0}</span><span>Pending</span></div>
            <div className="metric"><span className="value">{metrics.running ?? 0}</span><span>Running</span></div>
            <div className="metric"><span className="value">{metrics.done ?? 0}</span><span>Done</span></div>
            <div className="metric"><span className="value">{metrics.failed ?? 0}</span><span>Failed</span></div>
            <div className="metric dlq"><span className="value">{metrics.dlq_count ?? 0}</span><span>DLQ</span></div>
          </div>
        )}
      </section>

      <section className="submit-section">
        <h2>Submit job</h2>
        <form onSubmit={handleSubmit} className="submit-form">
          <label>
            Text to process
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="e.g. Hello (5 chars = 5 sec)"
              className="input-text"
            />
          </label>
          <div className="quick-submit">
            <span className="quick-submit-label">Quick submit:</span>
            <button type="button" className="btn-quick" onClick={() => quickSubmitText('Process Image parallel')}>Process Image parallel</button>
            <button type="button" className="btn-quick" onClick={() => quickSubmitText('Start the backend')}>Start the backend</button>
            <button type="button" className="btn-quick" onClick={() => quickSubmitText('Restart server')}>Restart server</button>
            <button type="button" className="btn-quick" onClick={() => quickSubmitText('restart Backend with dev Server')}>restart Backend with dev Server</button>
          </div>
          <div className="form-row">
            <label>
              Idempotency key (optional)
              <input
                type="text"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="e.g. my-unique-key"
              />
            </label>
            <label>
              Tenant ID (optional)
              <input
                type="text"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                placeholder="default"
              />
            </label>
          </div>
          <button type="submit" className="btn-primary">Submit job</button>
          {submitStatus.type && (
            <p className={`submit-feedback ${submitStatus.type}`}>{submitStatus.message}</p>
          )}
        </form>
      </section>

      <section className="jobs-section">
        <div className="section-head">
          <h2>Jobs</h2>
          <div className="tabs">
            {['all', ...STATUSES].map((s) => (
              <button
                key={s}
                className={filter === s ? 'active' : ''}
                onClick={() => setFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {loading && jobs.length === 0 ? (
          <p className="muted">Loading…</p>
        ) : filteredJobs.length === 0 ? (
          <p className="muted">No jobs in this view.</p>
        ) : (
          <div className="job-list">
            {filteredJobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        )}
      </section>

      <section className="dlq-section">
        <h2>Dead letter queue</h2>
        {dlq.length === 0 ? (
          <p className="muted">No DLQ items.</p>
        ) : (
          <div className="job-list">
            {dlq.map((item) => (
              <DlqRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      <footer className="footer">
        <p>
          Polling every {error ? POLL_INTERVAL_WHEN_ERROR_MS / 1000 : hasActiveJobs ? POLL_INTERVAL_REALTIME_MS / 1000 : POLL_INTERVAL_MS / 1000}s
          {hasActiveJobs && ' (real-time)'}
          {lastUpdatedAt && (
            <> · Last updated {lastUpdatedAt.toLocaleTimeString()}</>
          )}
          {' · '}
          Backend: <code>localhost:8000</code>
        </p>
      </footer>
    </div>
  );
}
