import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import type { CsvImportService } from './csv-import.service.js';

/** Bucket layout (SPEC §6.2). Uploads go to incoming/; only the CSV Lambda writes the others. */
export const INCOMING = 'incoming/';
export const PROCESSED = 'processed/';
export const REJECTED = 'rejected/';

/** Files bigger than this are refused without being read (Lambda memory, and no real bill file is this big). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The few file operations the import needs. S3 on AWS; a fake in tests. */
export interface CsvFileStore {
  read(key: string): Promise<Uint8Array>;
  write(key: string, text: string): Promise<void>;
  /** S3 has no rename: copy, then delete the original. */
  move(from: string, to: string): Promise<void>;
}

export class S3CsvFileStore implements CsvFileStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async read(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`s3://${this.bucket}/${key} has no body`);
    return res.Body.transformToByteArray();
  }

  async write(key: string, text: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: text, ContentType: 'text/csv; charset=utf-8' }),
    );
  }

  async move(from: string, to: string): Promise<void> {
    // CopySource is "<bucket>/<key>" with the key URL-encoded (slashes kept).
    const source = `${this.bucket}/${encodeURIComponent(from).replaceAll('%2F', '/')}`;
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: source }));
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: from }));
  }
}

export type FileOutcome = 'processed' | 'refused' | 'ignored';

/**
 * What happens to one uploaded file:
 *
 *   incoming/bills.csv
 *     usable     -> bills queued; bad rows in rejected/bills.errors.csv (if any);
 *                   file moved to processed/bills.csv
 *     unusable   -> (too big, not UTF-8, missing columns, ...) nothing queued;
 *                   reason in rejected/bills.errors.csv; file moved to rejected/bills.csv
 *
 * The file is moved last. If the Lambda dies before that, S3 invokes it again
 * and the bills already queued are recognised as duplicates.
 */
export class CsvFileHandler {
  private readonly logger = new Logger(CsvFileHandler.name);

  constructor(
    private readonly importer: Pick<CsvImportService, 'importBills'>,
    private readonly files: CsvFileStore,
  ) {}

  async handle(key: string, size: number, uploadedAt: string): Promise<FileOutcome> {
    if (!key.startsWith(INCOMING) || key.endsWith('/')) {
      this.logger.warn(`Ignoring ${key}: not a file under ${INCOMING}`);
      return 'ignored';
    }
    const name = key.slice(INCOMING.length);
    const errorsKey = `${REJECTED}${name.replace(/\.csv$/i, '')}.errors.csv`;

    if (size > MAX_FILE_BYTES) {
      await this.files.write(errorsKey, `reason\r\nThe file is ${size} bytes; the limit is ${MAX_FILE_BYTES}.\r\n`);
      await this.files.move(key, `${REJECTED}${name}`);
      this.logger.warn(`${name} refused: too large (${size} bytes)`);
      return 'refused';
    }

    const summary = await this.importer.importBills(await this.files.read(key), name, uploadedAt);
    if (summary.errorsCsv) await this.files.write(errorsKey, summary.errorsCsv);
    if (summary.fileError) {
      await this.files.move(key, `${REJECTED}${name}`);
      return 'refused';
    }
    await this.files.move(key, `${PROCESSED}${name}`);
    return 'processed';
  }
}

/** Object keys in S3 event notifications are URL-encoded, with + for spaces. */
export function decodeS3Key(key: string): string {
  return decodeURIComponent(key.replaceAll('+', ' '));
}
