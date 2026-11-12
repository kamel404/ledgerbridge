import { Logger as PowertoolsLogger } from '@aws-lambda-powertools/logger';
import { JsonLogger } from './json-logger.js';
import { addLogContext, withLogContext } from './log-context.js';
import { maskEmail, redact } from './redact.js';
import { PowertoolsSyncMetrics } from './sync-metrics.js';

/**
 * Captures everything written to stdout and stderr while `fn` runs, one entry
 * per JSON line. (Powertools writes ERROR lines to stderr; Lambda sends both
 * streams to CloudWatch.)
 */
async function captureStdout(fn: () => unknown): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const capture = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };
  const spies = [vi.spyOn(process.stdout, 'write').mockImplementation(capture), vi.spyOn(process.stderr, 'write').mockImplementation(capture)];
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return lines
    .join('')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('redact', () => {
  it('masks emails, bearer tokens and secret-looking pairs', () => {
    expect(maskEmail('ap@cedar.example')).toBe('a***@cedar.example');
    expect(redact('mail finance@byblos.example now')).toBe('mail f***@byblos.example now');
    expect(redact('Authorization: Bearer eyJhbGciOi.abc.def')).toBe('Authorization: ***');
    expect(redact('{"authorization":"Basic dXNlcjpwYXNz"}')).toBe('{"authorization":"***"}');
    expect(redact('sent Bearer eyJhbGciOi.abc.def to the ERP')).toBe('sent Bearer *** to the ERP');
    expect(redact('client_secret=hunter2&grant_type=x')).toBe('client_secret=***&grant_type=x');
    expect(redact('{"clientSecret":"s3cr3t"}')).toBe('{"clientSecret":"***"}');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('INV-1042 SUCCEEDED (receive 2)')).toBe('INV-1042 SUCCEEDED (receive 2)');
  });
});

describe('withLogContext', () => {
  it('nests, survives awaits, and can be extended', async () => {
    const seen: unknown[] = [];
    const { currentLogContext } = await import('./log-context.js');
    await withLogContext({ eventId: 'e1', flow: 'O2C' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      addLogContext({ attempt: 2 });
      await withLogContext({ eventType: 'invoice.created' }, async () => seen.push({ ...currentLogContext() }));
    });
    seen.push(currentLogContext());
    expect(seen).toEqual([{ eventId: 'e1', flow: 'O2C', attempt: 2, eventType: 'invoice.created' }, {}]);
  });
});

describe('JsonLogger', () => {
  const logger = new JsonLogger(new PowertoolsLogger({ serviceName: 'test' }));

  it('writes one JSON line with the event fields and the class name', async () => {
    const [line] = await captureStdout(() =>
      withLogContext({ eventId: 'evt_1', flow: 'O2C', eventType: 'invoice.created', attempt: 1 }, async () =>
        logger.log('SUCCEEDED', 'SqsBatchHandler'),
      ),
    );
    expect(line).toMatchObject({
      level: 'INFO',
      message: 'SUCCEEDED',
      service: 'test',
      context: 'SqsBatchHandler',
      eventId: 'evt_1',
      flow: 'O2C',
      eventType: 'invoice.created',
      attempt: 1,
    });
  });

  it('redacts the message and includes errors', async () => {
    const [line] = await captureStdout(() =>
      logger.error('failed for ap@cedar.example', new Error('token=abc123 rejected'), 'Worker'),
    );
    expect(line!.message).toBe('failed for a***@cedar.example');
    expect(line!.error).toMatchObject({ name: 'Error', message: 'token=*** rejected' });
  });

  it("turns Nest's start-up chatter into debug (hidden at INFO)", async () => {
    const lines = await captureStdout(() => logger.log('AppModule dependencies initialized', 'InstanceLoader'));
    expect(lines).toEqual([]);
  });
});

describe('PowertoolsSyncMetrics', () => {
  it('writes Embedded Metric Format lines with a flow dimension, namespace LedgerBridge', async () => {
    const lines = await captureStdout(() => new PowertoolsSyncMetrics().attempt('P2P', 'RETRYING', 42));
    expect(lines).toHaveLength(2);
    const [count, duration] = lines;
    expect(count).toMatchObject({ SyncRetried: 1, flow: 'P2P' });
    expect(duration).toMatchObject({ SyncDurationMs: 42, flow: 'P2P' });
    const emf = (count!._aws as { CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][] }> }).CloudWatchMetrics[0]!;
    expect(emf.Namespace).toBe('LedgerBridge');
    // Recorded here so CDK alarms use exactly these dimensions (see infra/lib/observability.ts).
    expect(emf.Dimensions).toEqual([['service', 'flow']]);
  });
});
