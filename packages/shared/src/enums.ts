import { z } from 'zod';

/** Lifecycle of one event in the sync log (SPEC §8.5). */
export const SyncStatus = z.enum([
  'RECEIVED',
  'PROCESSING',
  'SUCCEEDED',
  'RETRYING',
  'FAILED',
  'DEAD',
  'REJECTED',
]);
export type SyncStatus = z.infer<typeof SyncStatus>;

/** Business flow an event belongs to: Order-to-Cash or Procure-to-Pay. */
export const Flow = z.enum(['O2C', 'P2P']);
export type Flow = z.infer<typeof Flow>;

/** Where an event entered LedgerBridge. */
export const Source = z.enum(['billing', 'procurement', 'csv']);
export type Source = z.infer<typeof Source>;

/** Whether a failure is worth retrying (SPEC §8.2). */
export const ErrorClass = z.enum(['retryable', 'permanent']);
export type ErrorClass = z.infer<typeof ErrorClass>;
