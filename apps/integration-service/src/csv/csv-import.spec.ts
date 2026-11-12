import { EventIntakeService } from '../intake/event-intake.service.js';
import { InMemorySyncLogRepository } from '../sync-log/in-memory-sync-log.repository.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import { CsvFileHandler, MAX_FILE_BYTES, type CsvFileStore } from './csv-file-handler.js';
import { CsvImportService } from './csv-import.service.js';

const HEADER = 'bill_number,vendor_id,vendor_name,bill_date,due_date,currency,expense_category,description,amount';
const GOOD = 'B-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,10';
const BAD = 'B-2,V-2,Globex,2026-11-01,,USD,YACHTS,,10';
const AT = '2026-11-12T10:00:00.000Z';

class FakeFiles implements CsvFileStore {
  readonly objects = new Map<string, string>();
  async read(key: string) {
    return Buffer.from(this.objects.get(key)!);
  }
  async write(key: string, text: string) {
    this.objects.set(key, text);
  }
  async move(from: string, to: string) {
    this.objects.set(to, this.objects.get(from)!);
    this.objects.delete(from);
  }
}

function setup() {
  const repo = new InMemorySyncLogRepository();
  const syncLog = new SyncLogService(repo);
  const dispatch = vi.fn(async () => undefined);
  const importer = new CsvImportService(new EventIntakeService(syncLog, { dispatch }));
  const files = new FakeFiles();
  const handler = new CsvFileHandler(importer, files);
  const upload = (name: string, text: string) => {
    files.objects.set(`incoming/${name}`, text);
    return handler.handle(`incoming/${name}`, Buffer.byteLength(text), AT);
  };
  return { repo, dispatch, files, handler, upload };
}

describe('CSV import (file handler + import service)', () => {
  it('queues the valid bills, writes the errors file, moves the file to processed/', async () => {
    const t = setup();
    await expect(t.upload('bills-nov.csv', `${HEADER}\n${GOOD}\n${BAD}\n`)).resolves.toBe('processed');

    expect(t.dispatch).toHaveBeenCalledTimes(1);
    const [record] = t.repo.all();
    expect(record).toMatchObject({ source: 'csv', flow: 'P2P', status: 'RECEIVED', businessKey: 'B-1', eventType: 'bill.approved' });
    expect(record!.eventId).toMatch(/^csv:[0-9a-f]{64}:B-1$/);

    expect([...t.files.objects.keys()].sort()).toEqual(['processed/bills-nov.csv', 'rejected/bills-nov.errors.csv']);
    expect(t.files.objects.get('rejected/bills-nov.errors.csv')).toContain('B-2,V-2,Globex');
  });

  it('writes no errors file when every row is valid', async () => {
    const t = setup();
    await t.upload('ok.csv', `${HEADER}\n${GOOD}\n`);
    expect([...t.files.objects.keys()]).toEqual(['processed/ok.csv']);
  });

  it('the same file uploaded again creates nothing new', async () => {
    const t = setup();
    const text = `${HEADER}\n${GOOD}\n`;
    await t.upload('bills.csv', text);
    await t.upload('bills-copy.csv', text); // same bytes, other name

    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.repo.all()).toHaveLength(1);
    expect(t.files.objects.has('processed/bills-copy.csv')).toBe(true);
  });

  it('moves an unusable file to rejected/ with the reason, and queues nothing', async () => {
    const t = setup();
    await expect(t.upload('wrong.csv', 'name,amount\nX,1\n')).resolves.toBe('refused');
    expect(t.dispatch).not.toHaveBeenCalled();
    expect([...t.files.objects.keys()].sort()).toEqual(['rejected/wrong.csv', 'rejected/wrong.errors.csv']);
    expect(t.files.objects.get('rejected/wrong.errors.csv')).toContain('Missing column(s)');
  });

  it('refuses a file over the size limit without reading it', async () => {
    const t = setup();
    t.files.objects.set('incoming/huge.csv', 'x');
    const read = vi.spyOn(t.files, 'read');
    await expect(t.handler.handle('incoming/huge.csv', MAX_FILE_BYTES + 1, AT)).resolves.toBe('refused');
    expect(read).not.toHaveBeenCalled();
    expect(t.files.objects.has('rejected/huge.csv')).toBe(true);
  });

  it('ignores anything outside incoming/', async () => {
    const t = setup();
    await expect(t.handler.handle('processed/x.csv', 10, AT)).resolves.toBe('ignored');
  });
});
