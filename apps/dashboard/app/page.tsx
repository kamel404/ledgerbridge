import Link from 'next/link';
import { adminApi } from '@/lib/admin-api';
import { formatTime } from '@/lib/format';
import { FLOWS, type SyncStatus } from '@/lib/types';
import { AutoRefresh } from './auto-refresh';

// Always fetch fresh numbers; nothing is cached or pre-rendered.
export const dynamic = 'force-dynamic';

const TILES: Array<{ status: SyncStatus; label: string; tone: string; hint: string }> = [
  { status: 'SUCCEEDED', label: 'Succeeded', tone: 'ok', hint: 'in the ERP' },
  { status: 'RETRYING', label: 'Retrying', tone: 'warn', hint: 'temporary failure' },
  { status: 'FAILED', label: 'Failed', tone: 'bad', hint: 'needs a fix, then Replay' },
  { status: 'DEAD', label: 'Dead', tone: 'bad', hint: 'gave up after 4 tries' },
];

export default async function OverviewPage() {
  const stats = await adminApi.stats();
  const inProgress = stats.byStatus.RECEIVED + stats.byStatus.PROCESSING;

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">
        Events by their current status, last 24 hours ({formatTime(stats.since)} to now). <AutoRefresh seconds={15} />
      </p>

      <div className="tiles">
        {TILES.map((t) => (
          <Link key={t.status} href={`/syncs?status=${t.status}`} className={`tile ${stats.byStatus[t.status] ? t.tone : ''}`}>
            <div className="label">{t.label}</div>
            <div className="value">{stats.byStatus[t.status]}</div>
            <div className="hint">{t.hint}</div>
          </Link>
        ))}
        <div className="tile">
          <div className="label">In progress</div>
          <div className="value">{inProgress}</div>
          <div className="hint">received or processing</div>
        </div>
        <div className="tile">
          <div className="label">Rejected</div>
          <div className="value">{stats.byStatus.REJECTED}</div>
          <div className="hint">invalid at the door</div>
        </div>
      </div>

      <h2>Queues</h2>
      <div className="tiles">
        {stats.queues ? (
          <>
            <div className="tile">
              <div className="label">Sync queue</div>
              <div className="value">{stats.queues.queue.waiting}</div>
              <div className="hint">waiting · {stats.queues.queue.inFlight} in progress or waiting to retry</div>
            </div>
            <div className={`tile ${stats.queues.dlq.waiting ? 'bad' : ''}`}>
              <div className="label">Dead-letter queue</div>
              <div className="value">{stats.queues.dlq.waiting}</div>
              <div className="hint">usually 0: dead events are marked DEAD and moved out within seconds</div>
            </div>
          </>
        ) : (
          <div className="tile">
            <div className="label">Queues</div>
            <div className="value">–</div>
            <div className="hint">no queues (running locally)</div>
          </div>
        )}
        <div className="tile">
          <div className="label">Last reconciliation</div>
          <div className="value">–</div>
          <div className="hint">arrives in Phase 8</div>
        </div>
      </div>

      <h2>By flow</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Flow</th>
              {TILES.map((t) => (
                <th key={t.status} className="num">
                  {t.label}
                </th>
              ))}
              <th className="num">Rejected</th>
            </tr>
          </thead>
          <tbody>
            {FLOWS.map((flow) => (
              <tr key={flow}>
                <td>{flow === 'O2C' ? 'O2C · order to cash' : 'P2P · procure to pay'}</td>
                {TILES.map((t) => (
                  <td key={t.status} className="num">
                    {stats.byFlow[flow][t.status] ? (
                      <Link href={`/syncs?status=${t.status}&flow=${flow}`}>{stats.byFlow[flow][t.status]}</Link>
                    ) : (
                      0
                    )}
                  </td>
                ))}
                <td className="num">{stats.byFlow[flow].REJECTED}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
