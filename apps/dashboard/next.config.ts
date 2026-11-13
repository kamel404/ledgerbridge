import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // `next build` also writes .next/standalone: a minimal Node server plus only the
  // node_modules files it uses. scripts/package-web.mjs zips that into the AWS
  // Web Function (infra/lib/ledgerbridge-stack.ts). `next dev` / `next start` ignore it.
  output: 'standalone',
  // npm workspaces keep node_modules at the repo root, so trace files from there.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // Don't advertise the framework in response headers.
  poweredByHeader: false,
  // Don't let `next dev` write an AGENTS.md into the project.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The dashboard can't be framed by another site (clickjacking a Replay button).
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default config;
