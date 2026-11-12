import { S3Client } from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import { addLambdaContext, nestLoggerOptions } from '../observability/json-logger.js';
import type { Handler, S3Event } from 'aws-lambda';
import { CsvFileHandler, decodeS3Key, S3CsvFileStore } from '../csv/csv-file-handler.js';
import { CsvImportService } from '../csv/csv-import.service.js';
import { CsvAppModule } from '../csv/csv.module.js';

// Lambda entry point for CSV imports: S3 calls it when a file is created
// under incoming/ in the import bucket. Nest runs without an HTTP server.
let cached: Promise<{ importer: CsvImportService; s3: S3Client }> | undefined;

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(CsvAppModule, nestLoggerOptions());
  return { importer: app.get(CsvImportService), s3: new S3Client({}) };
}

export const handler: Handler<S3Event, void> = async (event, context) => {
  addLambdaContext(context);
  cached ??= bootstrap().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  const { importer, s3 } = await cached;
  // Usually one record per event. A throw makes Lambda retry the whole event
  // (twice, for S3's asynchronous calls); already-queued bills are then duplicates.
  for (const record of event.Records) {
    const files = new CsvFileHandler(importer, new S3CsvFileStore(s3, record.s3.bucket.name));
    await files.handle(decodeS3Key(record.s3.object.key), record.s3.object.size, record.eventTime);
  }
};
