import Link from 'next/link';

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="sub">There is no sync record with this ID. It may have expired (records are kept 90 days).</p>
      <Link href="/syncs">← All syncs</Link>
    </>
  );
}
