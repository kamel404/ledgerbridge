import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isSignedIn } from '@/lib/auth';
import { safeNext } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · LedgerBridge' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await isSignedIn()) redirect(next);
  return (
    <>
      <h1>Sign in</h1>
      <p className="sub">Enter the dashboard password.</p>
      <LoginForm next={next} />
    </>
  );
}
