// Runs the AWS CLI for the scripts in this folder, always in the project's
// Region and with the project's profile.
//
// Uses profile `ledgerbridge` (override: AWS_PROFILE=...). Credentials come
// from `aws login --profile ledgerbridge` and last 12 hours.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Our AWS project only allows resources in its selected Region. */
export const REGION = 'eu-north-1';
export const PROFILE = process.env.AWS_PROFILE ?? 'ledgerbridge';

let cli: string | undefined;

/** The AWS CLI: on PATH, or where its Windows installer puts it. */
function awsCli(): string {
  if (cli) return cli;
  const candidates = ['aws'];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'));
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return (cli = c);
    } catch {
      // try the next one
    }
  }
  throw new Error('AWS CLI not found. Install it (see docs/PLAN.md Part A.5).');
}

/** Runs one AWS CLI command and returns its stdout. Throws with the CLI's stderr on failure. */
export function aws(args: string[]): string {
  return execFileSync(awsCli(), [...args, '--region', REGION, '--profile', PROFILE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' },
  });
}

/**
 * Calls a deployed Lambda and waits for its answer. Returns what the function
 * returned (parsed JSON). Throws if the function itself failed.
 */
export function invokeLambda(functionName: string, payload: unknown): unknown {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-invoke-'));
  const outFile = path.join(dir, 'out.json');
  try {
    const meta = JSON.parse(
      aws([
        'lambda', 'invoke',
        '--function-name', functionName,
        '--cli-binary-format', 'raw-in-base64-out',
        '--payload', JSON.stringify(payload),
        '--cli-read-timeout', '320', // the reconcile Lambda may take up to 5 minutes
        outFile,
      ]),
    ) as { FunctionError?: string };
    const result = JSON.parse(readFileSync(outFile, 'utf8')) as unknown;
    if (meta.FunctionError) {
      const { errorMessage } = (result ?? {}) as { errorMessage?: string };
      throw new Error(`${functionName} failed: ${errorMessage ?? JSON.stringify(result)}`);
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A hint to print when an AWS call failed because the login expired. */
export function loginHint(err: unknown): string | undefined {
  const stderr = String((err as { stderr?: string }).stderr ?? '');
  return /ExpiredToken|Unable to locate credentials|login|expired/i.test(stderr)
    ? `Your AWS login may have expired. Run: aws login --profile ${PROFILE}`
    : undefined;
}
