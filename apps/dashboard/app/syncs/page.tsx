import Link from 'next/link';
import { adminApi, syncsQuery } from '@/lib/admin-api';
import { formatTime, parseFilters, syncHref, timeAgo } from '@/lib/format';
import { FLOWS, SYNC_STATUSES } from '@/lib/types';
import { StatusBadge } from '../status-badge';

export const dynamic = 'force-dynamic';

/**
 * All syncs, newest first. The filter form is a plain GET form: the filters
 * live in the URL, so a filtered view can be bookmarked or shared, and the
 * page works without JavaScript.
 */
export default async function SyncsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseFilters(await searchParams);
  const page = await adminApi.listSyncs(filters);
  const { cursor: _cursor, ...withoutCursor } = filters;
  const now = Date.now();

  return (
    <>
      <h1>Syncs</h1>
      <p className="sub">Every event LedgerBridge received, newest change first. Click a row for details and Replay.</p>

      <form className="filters" method="get" action="/syncs">
        <label>
          Status
          <select name="status" defaultValue={filters.status ?? ''}>
            <option value="">All</option>
            {SYNC_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Flow
          <select name="flow" defaultValue={filters.flow ?? ''}>
            <option value="">All</option>
            {FLOWS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input type="search" name="q" defaultValue={filters.q ?? ''} placeholder="INV-1042, BILL-…, or an event ID" maxLength={100} />
        </label>
        <button type="submit" className="primary">
          Apply
        </button>
        {(filters.status || filters.flow || filters.q) && <Link href="/syncs">Clear</Link>}
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Flow</th>
              <th>Event type</th>
              <th>Business key</th>
              <th className="num">Attempts</th>
              <th>Error</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {page.items.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nothing matches these filters.
                </td>
              </tr>
            )}
            {page.items.map((s) => (
              <tr key={s.eventId}>
                <td>
                  <Link href={syncHref(s.eventId)}>
                    <StatusBadge status={s.status} />
                  </Link>
                </td>
                <td>{s.flow}</td>
                <td>{s.eventType ?? <span className="muted">unknown</span>}</td>
                <td className="mono">
                  <Link href={syncHref(s.eventId)}>{s.businessKey ?? s.eventId}</Link>
                </td>
                <td className="num">{s.attempts}</td>
                <td className="mono">{s.lastError?.code ?? ''}</td>
                <td title={formatTime(s.updatedAt)}>{timeAgo(s.updatedAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        {filters.cursor && <Link href={`/syncs${syncsQuery(withoutCursor)}`}>← First page</Link>}
        {page.nextCursor && <Link href={`/syncs${syncsQuery({ ...withoutCursor, cursor: page.nextCursor })}`}>Next page →</Link>}
      </div>
    </>
  );
}
