import { Inject, Injectable } from '@nestjs/common';
import { MOCK_ERP_CONFIG, type ChaosSettings, type MockErpConfig } from '../config/mock-erp.config.js';
import { NetSuiteError } from '../common/netsuite-error.js';

/** Sources of randomness and time, replaceable in tests. */
export interface ChaosClock {
  random(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const CHAOS_CLOCK = Symbol('CHAOS_CLOCK');

export const systemClock: ChaosClock = {
  random: () => Math.random(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Failure injection (SPEC §7.4), to test how the integration copes:
 * - latency:    every ERP request waits `latencyMs` first
 * - rate limit: more than `rateLimitPerSecond` requests in one second -> 429 + Retry-After
 * - errors:     a random `errorRate` fraction of requests -> 503
 *
 * Settings start from env vars and can be changed at runtime via /mock/chaos.
 * On Lambda each container has its own copy, so runtime changes only reach
 * the container that handled them; use the env vars there.
 */
@Injectable()
export class ChaosService {
  private settings: ChaosSettings;
  private windowStart = 0;
  private windowCount = 0;

  constructor(
    @Inject(MOCK_ERP_CONFIG) config: MockErpConfig,
    @Inject(CHAOS_CLOCK) private readonly clock: ChaosClock,
  ) {
    this.settings = { ...config.chaos };
  }

  get(): ChaosSettings {
    return { ...this.settings };
  }

  update(changes: Partial<ChaosSettings>): ChaosSettings {
    this.settings = { ...this.settings, ...changes };
    return this.get();
  }

  /** Called before every ERP request. Waits, or throws a 429/503 NetSuiteError. */
  async beforeRequest(): Promise<void> {
    const { latencyMs, rateLimitPerSecond, errorRate } = this.settings;

    if (latencyMs > 0) await this.clock.sleep(latencyMs);

    if (rateLimitPerSecond > 0) {
      const now = this.clock.now();
      if (now - this.windowStart >= 1000) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      this.windowCount++;
      if (this.windowCount > rateLimitPerSecond) {
        const retryAfter = Math.max(1, Math.ceil((this.windowStart + 1000 - now) / 1000));
        throw new NetSuiteError(
          429,
          'REQUEST_LIMIT_EXCEEDED',
          `More than ${rateLimitPerSecond} requests per second. Retry after ${retryAfter}s.`,
          { 'Retry-After': String(retryAfter) },
        );
      }
    }

    if (errorRate > 0 && this.clock.random() < errorRate) {
      throw new NetSuiteError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable (chaos)');
    }
  }
}
