import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminApiError, adminApi } from '@/lib/admin-api';
import { decodeParam, formatTime, prettyJson, REPLAYABLE, STATUS_INFO } from '@/lib/format';
import type { SyncRecord } from '@/lib/types';
import { StatusBadge } from '../../status-badge';
import { ReplayButton } from './replay-button';

export const dynamic = 'force-dynamic';

export default async function SyncDetailPage({ params }: { params: Promise<{ eventId: string }> }) {
  const eventId = decodeParam((await params).eventId);
  let sync: SyncRecord;
  try {
    sync = await adminApi.getSync(eventId);
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <>
      <p className="sub">
        <Link href="/syncs">← All syncs</Link>
      </p>
      <h1>
        {sync.businessKey ?? sync.eventType ?? 'Event'} <StatusBadge status={sync.status} />
      </h1>
      <p className="sub">{STATUS_INFO[sync.status].meaning}</p>

      {REPLAYABLE.includes(sync.status) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ marginTop: 0 }}>
            Replay sends this event to the queue again, with attempts starting from 0. Fix the cause first (turn the
            ERP back on, add the missing mapping, ...), or it will fail the same way.
          </p>
          <ReplayButton eventId={sync.eventId} />
        </div>
      )}

      {sync.lastError && (
        <div className="error-box" style={{ marginBottom: 16 }}>
          <div>
            <span className="code">{sync.lastError.code}</span> ·{' '}
            {sync.lastError.class === 'retryable' ? 'temporary (retryable)' : 'permanent (not retried)'}
          </div>
          <div>{sync.lastError.message}</div>
        </div>
      )}

      <div className="grid2">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Details</h2>
          <dl className="facts">
            <dt>Event ID</dt>
            <dd className="mono">{sync.eventId}</dd>
            <dt>Type</dt>
            <dd>{sync.eventType ?? 'unknown'}</dd>
            <dt>Flow · source</dt>
            <dd>
              {sync.flow} · {sync.source}
            </dd>
            <dt>Attempts</dt>
            <dd>{sync.attempts}</dd>
            <dt>ERP record</dt>
            <dd>{sync.erpRecordId ? `${sync.erpRecordType} ${sync.erpRecordId}` : <span className="muted">none yet</span>}</dd>
            <dt>Received</dt>
            <dd>{formatTime(sync.receivedAt)}</dd>
            <dt>Last change</dt>
            <dd>{formatTime(sync.updatedAt)}</dd>
            {sync.completedAt && (
              <>
                <dt>Completed</dt>
                <dd>{formatTime(sync.completedAt)}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Timeline</h2>
          <ol className="timeline">
            {sync.history.map((h, i) => (
              <li key={i}>
                <time>{formatTime(h.at)}</time>
                <span>
                  <StatusBadge status={h.status} />
                </span>
                <span className="muted">{h.note ?? ''}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <h2>Payload</h2>
      <pre className="json">{prettyJson(sync.payload)}</pre>
    </>
  );
}
