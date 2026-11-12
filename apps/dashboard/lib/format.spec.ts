import { decodeParam, formatTime, parseFilters, syncHref, timeAgo } from './format';

describe('format helpers', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');

  it('timeAgo', () => {
    expect(timeAgo('2026-11-12T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-11-12T11:57:00Z', now)).toBe('3 min ago');
    expect(timeAgo('2026-11-12T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-11-10T12:00:00Z', now)).toBe('2 d ago');
  });

  it('formatTime', () => {
    expect(formatTime('2026-11-12T14:03:07.123Z')).toBe('2026-11-12 14:03:07 UTC');
  });

  it('parseFilters keeps valid values and drops the rest', () => {
    expect(parseFilters({ status: 'DEAD', flow: 'P2P', q: '  INV-1 ', cursor: 'abc' })).toEqual({
      status: 'DEAD',
      flow: 'P2P',
      q: 'INV-1',
      cursor: 'abc',
    });
    expect(parseFilters({ status: 'BOGUS', flow: '', q: ['a', 'b'] })).toEqual({ q: 'a' });
  });

  it('event IDs with colons round-trip through the URL', () => {
    const id = 'csv:3f2a:BILL-7';
    const href = syncHref(id);
    expect(href).toBe('/syncs/csv%3A3f2a%3ABILL-7');
    expect(decodeParam(href.split('/')[2]!)).toBe(id);
    expect(decodeParam('%E0%A4%A')).toBe('%E0%A4%A'); // broken encoding: left as is
  });
});
