import { SyncStatus } from './enums.js';

describe('SyncStatus', () => {
  it('accepts a known status', () => {
    expect(SyncStatus.parse('SUCCEEDED')).toBe('SUCCEEDED');
  });

  it('rejects an unknown status', () => {
    expect(SyncStatus.safeParse('DONE').success).toBe(false);
  });
});
