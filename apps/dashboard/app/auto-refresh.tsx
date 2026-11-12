'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Re-renders the page on the server every `seconds` (SPEC §9: overview
 * refreshes every 15 s). router.refresh() re-runs the server component, so the
 * admin API is still called from the server, never from the browser.
 * Pauses while the tab is hidden.
 */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [at, setAt] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      setAt(new Date());
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return (
    <span className="refreshed" suppressHydrationWarning>
      Refreshes every {seconds} s · last {at.toLocaleTimeString()}
    </span>
  );
}
