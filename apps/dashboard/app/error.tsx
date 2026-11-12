'use client';

/**
 * Shown when a page can't load, e.g. the admin API is unreachable or not
 * configured. In production builds Next.js hides server error messages from
 * the browser, so the digest is what to look for in the dashboard's terminal.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="error-box">
      <h1 style={{ fontSize: 18 }}>Could not load this page</h1>
      <p>{error.message || 'The admin API call failed.'}</p>
      {error.digest && <p className="muted">Details are in the dashboard&apos;s terminal (digest {error.digest}).</p>}
      <p className="muted">
        Check ADMIN_API_URL and ADMIN_API_KEY in apps/dashboard/.env.local, and that the admin API is reachable.
      </p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
