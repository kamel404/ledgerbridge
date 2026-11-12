import { InMemorySyncLogRepository } from '../sync-log/in-memory-sync-log.repository.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import { invoiceEvent } from '../test-support/events.js';
import { EventIntakeService, STUCK_AFTER_MS } from './event-intake.service.js';

function setup() {
  const repo = new InMemorySyncLogRepository();
  const syncLog = new SyncLogService(repo);
  const dispatch = vi.fn(async () => undefined);
  const intake = new EventIntakeService(syncLog, { dispatch });
  return { repo, syncLog, dispatch, intake };
}

const input = { event: invoiceEvent(), source: 'billing' as const, flow: 'O2C' as const };

describe('EventIntakeService', () => {
  afterEach(() => vi.useRealTimers());

  it('logs RECEIVED and dispatches a new event', async () => {
    const t = setup();
    await expect(t.intake.accept(input)).resolves.toBe('accepted');
    expect(await t.syncLog.get('evt_inv_1')).toMatchObject({ status: 'RECEIVED', businessKey: 'INV-1042' });
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('ignores a duplicate that is already being processed or done', async () => {
    const t = setup();
    await t.intake.accept(input);
    await t.syncLog.transition('evt_inv_1', 'SUCCEEDED');
    await expect(t.intake.accept(input)).resolves.toBe('duplicate');
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not re-send a duplicate that is RECEIVED but recent (just waiting in the queue)', async () => {
    const t = setup();
    await t.intake.accept(input);
    await t.intake.accept(input);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('re-sends the stored event when a duplicate finds it stuck at RECEIVED', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = setup();
    await t.intake.accept(input);
    vi.setSystemTime(Date.now() + STUCK_AFTER_MS + 1);

    const changed = { ...input, event: { ...input.event, data: { ...input.event.data, currency: 'EUR' } } };
    await expect(t.intake.accept(changed)).resolves.toBe('duplicate');

    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(t.dispatch).toHaveBeenLastCalledWith('evt_inv_1', input.event); // the stored one, not the new body
  });
});
