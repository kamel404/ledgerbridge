import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'LedgerBridge',
  description: 'Operator dashboard: sync status, errors and replay',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            LedgerBridge
          </Link>
          <nav>
            <Link href="/">Overview</Link>
            <Link href="/syncs">Syncs</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
