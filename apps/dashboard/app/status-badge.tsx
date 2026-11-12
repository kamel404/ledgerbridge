import { STATUS_INFO } from '@/lib/format';
import type { SyncStatus } from '@/lib/types';

export function StatusBadge({ status }: { status: SyncStatus }) {
  const info = STATUS_INFO[status];
  return (
    <span className={`badge ${info.tone}`} title={info.meaning}>
      {status}
    </span>
  );
}
