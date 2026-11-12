import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields added to every log line written while one event is being handled
 * (SPEC §11): with them, a single Logs Insights query follows one event
 * through ingest, the worker and the DLQ handler.
 */
export interface LogFields {
  eventId?: string;
  flow?: string;
  eventType?: string;
  /** Sync attempt number (1 = first try). */
  attempt?: number;
  /** SQS receive count of the message being handled. */
  receiveCount?: number;
}

const storage = new AsyncLocalStorage<LogFields>();

/** Runs `fn` with these fields on every log line inside it (including awaited code). */
export function withLogContext<T>(fields: LogFields, fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

/** Adds fields to the current context, e.g. the attempt number once it's known. */
export function addLogContext(fields: LogFields): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

export function currentLogContext(): LogFields {
  return storage.getStore() ?? {};
}
