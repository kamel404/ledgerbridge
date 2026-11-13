import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { isSignedIn } from '@/lib/auth';
import { loadSettings } from '@/lib/settings';
import { logoutAction } from './login/actions';
import './globals.css';

// Every page shows live data and depends on the login cookie: render on each
// request, never at build time (when there are no secrets to read).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'LedgerBridge',
  description: 'Operator dashboard: sync status, errors and replay',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { auth } = await loadSettings();
  const showLogout = auth.mode === 'password' && (await isSignedIn());
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
            {showLogout && (
              <form action={logoutAction}>
                <button type="submit" className="link">
                  Log out
                </button>
              </form>
            )}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
