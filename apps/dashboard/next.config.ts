import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
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
