// Runs reconciliation on AWS now, instead of waiting for 02:00 UTC:
//
//   npm run reconcile                     checks the usual window: the last 24 hours,
//                                         minus the last 5 minutes (still settling)
//   npm run reconcile -- --include-recent also checks the last 5 minutes, so an event
//                                         sent a minute ago is included (for testing)
//
// Calls the deployed reconcile Lambda (name from infra/cdk-outputs.json) and
// prints its report. The result is also stored, so the dashboard's Overview
// shows it, and the ReconciliationMismatches alarm reacts to it.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeLambda, loginHint } from './aws-cli.ts';

interface Report {
  runAt: string;
  since: string;
  until: string;
  byType: Record<string, { synced: number; createdInErp: number; matched: number }>;
  mismatchCount: number;
  mismatches: Array<{ kind: string; recordType: string; externalId: string; erpRecordId?: string; eventId?: string }>;
}

/** The deployed reconcile Lambda's name, from `cdk deploy --outputs-file`. */
export function reconcileFunctionName(): string {
  const file = fileURLToPath(new URL('../infra/cdk-outputs.json', import.meta.url));
  const outputs = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>)
    : {};
  const name = outputs.LedgerBridgeStack?.ReconcileFunctionName;
  if (!name) throw new Error('No ReconcileFunctionName in infra/cdk-outputs.json. Run `npm run deploy` first.');
  return name;
}

export function runReconcile(includeRecent: boolean): Report {
  return invokeLambda(reconcileFunctionName(), includeRecent ? { includeRecent: true } : {}) as Report;
}

export function printReport(r: Report): void {
  console.log(`Checked ${r.since} to ${r.until}`);
  for (const [type, c] of Object.entries(r.byType)) {
    console.log(`  ${type.padEnd(16)} synced ${c.synced}, matched ${c.matched}, created in the ERP ${c.createdInErp}`);
  }
  if (r.mismatchCount === 0) {
    console.log('No mismatches: the ERP and the sync log agree.');
    return;
  }
  console.log(`${r.mismatchCount} mismatch(es):`);
  for (const m of r.mismatches) {
    const ids = [m.erpRecordId && `ERP id ${m.erpRecordId}`, m.eventId && `event ${m.eventId}`].filter(Boolean).join(', ');
    console.log(`  ${m.kind.padEnd(24)} ${m.recordType} ${m.externalId}${ids ? ` (${ids})` : ''}`);
  }
  if (r.mismatchCount > r.mismatches.length) console.log(`  ... and ${r.mismatchCount - r.mismatches.length} more (see the Lambda's logs)`);
}

// Run as a command (not when imported by the simulator).
// (Windows may spell the drive letter differently in the two paths, hence the lower-casing.)
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  try {
    console.log('Running reconciliation on AWS...');
    const report = runReconcile(process.argv.includes('--include-recent'));
    printReport(report);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    const hint = loginHint(err);
    if (hint) console.error(hint);
    process.exit(1);
  }
}
