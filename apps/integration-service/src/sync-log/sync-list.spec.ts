import { InMemorySyncLogRepository } from './in-memory-sync-log.repository.js';
import type { ListQuery } from './sync-list.js';
import type { SyncRecord } from './sync-record.js';

function rec(eventId: string, status: SyncRecord['status'], updatedAt: string, extra: Partial<SyncRecord> = {}): SyncRecord {
  return {
    eventId,
    source: 'billing',
    flow: 'O2C',
    eventType: 'invoice.created',
    status,
    attempts: 1,
    businessKey: `INV-${eventId}`,
    payload: { secret: 'not in list rows' },
    receivedAt: updatedAt,
    updatedAt,
    ttl: 0,
    history: [{ status, at: updatedAt }],
    ...extra,
  };
}

async function repoWith(records: SyncRecord[]) {
  const repo = new InMemorySyncLogRepository();
  for (const r of records) await repo.create(r);
  return repo;
}

/** Reads every page and returns the event IDs in order. */
async function allPages(repo: InMemorySyncLogRepository, query: Omit<ListQuery, 'cursor'>) {
  const ids: string[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await repo.list({ ...query, ...(cursor && { cursor }) });
    ids.push(page.items.map((r) => r.eventId));
    cursor = page.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error('never ended');
}

const t = (minute: number) => `2026-11-12T10:${String(minute).padStart(2, '0')}:00.000Z`;

describe('listing syncs (cursor pagination across statuses)', () => {
  it('lists all statuses newest first, page by page, with nothing missed or repeated', async () => {
    const statuses = ['SUCCEEDED', 'FAILED', 'DEAD', 'RETRYING'] as const;
    const records = Array.from({ length: 23 }, (_, i) => rec(`e${String(i).padStart(2, '0')}`, statuses[i % 4]!, t(i)));
    const repo = await repoWith(records);

    const pages = await allPages(repo, { limit: 5 });
    expect(pages.map((p) => p.length)).toEqual([5, 5, 5, 5, 3]);
    expect(pages.flat()).toEqual(records.map((r) => r.eventId).reverse());
  });

  it('filters by status, flow and search text', async () => {
    const repo = await repoWith([
      rec('a', 'FAILED', t(1)),
      rec('b', 'FAILED', t(2), { flow: 'P2P', businessKey: 'BILL-9' }),
      rec('c', 'DEAD', t(3), { businessKey: 'INV-1042' }),
      rec('d', 'SUCCEEDED', t(4), { businessKey: 'INV-1042' }),
    ]);
    expect((await allPages(repo, { limit: 10, status: 'FAILED' })).flat()).toEqual(['b', 'a']);
    expect((await allPages(repo, { limit: 10, flow: 'P2P' })).flat()).toEqual(['b']);
    expect((await allPages(repo, { limit: 10, q: 'inv-1042' })).flat()).toEqual(['d', 'c']); // any case
    expect((await allPages(repo, { limit: 10, q: 'a' })).flat()).toEqual(['a']); // exact event ID
  });

  it('returns summaries without payload or history', async () => {
    const repo = await repoWith([rec('a', 'FAILED', t(1))]);
    const [item] = (await repo.list({ limit: 5 })).items;
    expect(item).not.toHaveProperty('payload');
    expect(item).not.toHaveProperty('history');
    expect(item).toMatchObject({ eventId: 'a', status: 'FAILED', businessKey: 'INV-a' });
  });

  it('ends without a cursor when everything fits on one page', async () => {
    const repo = await repoWith([rec('a', 'FAILED', t(1)), rec('b', 'DEAD', t(2))]);
    expect(await repo.list({ limit: 5 })).not.toHaveProperty('nextCursor');
  });

  it('refuses a cursor that was tampered with', async () => {
    const repo = await repoWith([rec('a', 'FAILED', t(1))]);
    await expect(repo.list({ limit: 5, cursor: 'garbage' })).rejects.toThrow('Invalid cursor');
    const evil = Buffer.from(JSON.stringify({ HACKED: 'done' })).toString('base64url');
    await expect(repo.list({ limit: 5, cursor: evil })).rejects.toThrow('Invalid cursor');
  });

  it('counts records per status and flow since a time', async () => {
    const repo = await repoWith([
      rec('old', 'SUCCEEDED', '2026-11-10T00:00:00.000Z'),
      rec('a', 'SUCCEEDED', t(1)),
      rec('b', 'DEAD', t(2), { flow: 'P2P' }),
    ]);
    const counts = await repo.countSince('2026-11-11T00:00:00.000Z');
    expect(counts.SUCCEEDED).toEqual({ O2C: 1, P2P: 0 });
    expect(counts.DEAD).toEqual({ O2C: 0, P2P: 1 });
  });

  it('replaceIf only writes when the status is still the expected one', async () => {
    const repo = await repoWith([rec('a', 'DEAD', t(1))]);
    expect(await repo.replaceIf({ ...rec('a', 'RECEIVED', t(2)) }, 'DEAD')).toBe(true);
    expect(await repo.replaceIf({ ...rec('a', 'RECEIVED', t(3)) }, 'DEAD')).toBe(false); // second click
    expect((await repo.get('a'))!.updatedAt).toBe(t(2));
  });
});
