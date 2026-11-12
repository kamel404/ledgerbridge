import { Injectable, Logger } from '@nestjs/common';
import { EventIntakeService } from '../intake/event-intake.service.js';
import { withLogContext } from '../observability/log-context.js';
import { errorsCsv, readBillCsv } from './bill-csv.js';

export interface CsvImportSummary {
  fileHash: string;
  /** New bills sent to the queue. */
  accepted: number;
  /** Bills already imported before (same file uploaded again). */
  duplicates: number;
  rejectedRows: number;
  /** Set when the whole file was refused. */
  fileError?: string;
  /** Content for rejected/<file>.errors.csv, when anything was rejected. */
  errorsCsv?: string;
}

/**
 * Turns an uploaded vendor-bill CSV into bill.approved events and sends each
 * one through the same intake as a webhook (dedup, RECEIVED, queue). From
 * there the worker treats it like any other event; only `source` says "csv".
 */
@Injectable()
export class CsvImportService {
  private readonly logger = new Logger(CsvImportService.name);

  constructor(private readonly intake: EventIntakeService) {}

  async importBills(content: Uint8Array, fileName: string, occurredAt: string): Promise<CsvImportSummary> {
    const result = readBillCsv(content, occurredAt);
    let accepted = 0;
    let duplicates = 0;
    for (const event of result.events) {
      const outcome = await withLogContext({ eventId: event.id, flow: 'P2P', eventType: event.type }, async () => {
        const result = await this.intake.accept({ event, source: 'csv', flow: 'P2P' });
        this.logger.log(result === 'accepted' ? `Bill ${event.data.billNumber} queued` : `Bill ${event.data.billNumber} already imported`);
        return result;
      });
      if (outcome === 'accepted') accepted++;
      else duplicates++;
    }
    const rejectedRows = result.rejected.length;
    const hasErrors = Boolean(result.fileError) || rejectedRows > 0;

    // Counts only: row values never go to the logs.
    this.logger.log(
      `${fileName} (sha256 ${result.fileHash.slice(0, 12)}…): ` +
        (result.fileError
          ? `refused: ${result.fileError}`
          : `${accepted} bill(s) queued, ${duplicates} already imported, ${rejectedRows} row(s) rejected`),
    );
    return {
      fileHash: result.fileHash,
      accepted,
      duplicates,
      rejectedRows,
      ...(result.fileError && { fileError: result.fileError }),
      ...(hasErrors && { errorsCsv: errorsCsv(result) }),
    };
  }
}
