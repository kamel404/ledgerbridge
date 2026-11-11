import { NetSuiteError } from '../common/netsuite-error.js';
import { loadConfig } from '../config/mock-erp.config.js';
import { ChaosService, type ChaosClock } from './chaos.service.js';

function fakeClock(random = 0.5): ChaosClock & { time: number; slept: number[] } {
  const clock = {
    time: 10_000,
    slept: [] as number[],
    random: () => random,
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
    },
  };
  return clock;
}

function chaos(env: Record<string, string>, clock = fakeClock()): ChaosService {
  return new ChaosService(loadConfig({ RATE_LIMIT_PER_SECOND: '0', ...env }), clock);
}

async function errorOf(p: Promise<unknown>): Promise<NetSuiteError | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err as NetSuiteError;
  }
}

describe('ChaosService', () => {
  it('does nothing when everything is off', async () => {
    await expect(chaos({}).beforeRequest()).resolves.toBeUndefined();
  });

  it('answers 503 when the random draw is below the error rate', async () => {
    const err = await errorOf(chaos({ CHAOS_ERROR_RATE: '0.6' }, fakeClock(0.5)).beforeRequest());
    expect(err?.status).toBe(503);
    expect(err?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('lets the request through when the draw is above the error rate', async () => {
    await expect(chaos({ CHAOS_ERROR_RATE: '0.4' }, fakeClock(0.5)).beforeRequest()).resolves.toBeUndefined();
  });

  it('waits for the configured latency', async () => {
    const clock = fakeClock();
    await chaos({ CHAOS_LATENCY_MS: '250' }, clock).beforeRequest();
    expect(clock.slept).toEqual([250]);
  });

  it('allows N requests per second, then 429 with Retry-After, then resets', async () => {
    const clock = fakeClock();
    const service = chaos({ RATE_LIMIT_PER_SECOND: '2' }, clock);

    await service.beforeRequest();
    await service.beforeRequest();
    const err = await errorOf(service.beforeRequest());
    expect(err?.status).toBe(429);
    expect(err?.headers['Retry-After']).toBe('1');

    clock.time += 1000;
    await expect(service.beforeRequest()).resolves.toBeUndefined();
  });

  it('can be changed at runtime', async () => {
    const service = chaos({}, fakeClock(0));
    service.update({ errorRate: 1 });
    expect((await errorOf(service.beforeRequest()))?.status).toBe(503);
    service.update({ errorRate: 0 });
    await expect(service.beforeRequest()).resolves.toBeUndefined();
  });
});
