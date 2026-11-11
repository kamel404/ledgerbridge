import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NetSuiteError } from '../common/netsuite-error.js';
import { recordUrl, toResource } from './record-presenter.js';
import { toRecordType, type RecordType } from './record-types.js';
import { RecordsService } from './records.service.js';

type RecordId = { kind: 'internal'; id: string } | { kind: 'external'; externalId: string };

/**
 * NetSuite-shaped record API (SPEC §7.2).
 *
 *   POST   /{type}                 create        -> 204 + Location
 *   GET    /{type}/{id}            read by internal ID
 *   GET    /{type}/eid:{extId}     read by external ID
 *   PATCH  /{type}/{id}            partial update -> 204
 *   PUT    /{type}/eid:{extId}     upsert         -> 204 + Location
 *   DELETE /{type}/{id}            delete         -> 204
 *
 * Writes return no body, like NetSuite: the new record's URL (and so its
 * internal ID) is in the Location header.
 */
@Controller('services/rest/record/v1')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Post(':type')
  @HttpCode(204)
  async create(
    @Param('type') rawType: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const record = await this.records.create(parseType(rawType), body);
    res.location(recordUrl(req, record));
  }

  @Get(':type/:id')
  async read(
    @Param('type') rawType: string,
    @Param('id') rawId: string,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    const type = parseType(rawType);
    const id = parseId(rawId);
    const record =
      id.kind === 'internal'
        ? await this.records.getById(type, id.id)
        : await this.records.getByExternalId(type, id.externalId);
    return toResource(req, record);
  }

  @Patch(':type/:id')
  @HttpCode(204)
  async patch(
    @Param('type') rawType: string,
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const type = parseType(rawType);
    const id = parseId(rawId);
    const internalId =
      id.kind === 'internal' ? id.id : (await this.records.getByExternalId(type, id.externalId)).id;
    const record = await this.records.patch(type, internalId, body);
    res.location(recordUrl(req, record));
  }

  @Put(':type/:id')
  @HttpCode(204)
  async upsert(
    @Param('type') rawType: string,
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const type = parseType(rawType);
    const id = parseId(rawId);
    if (id.kind !== 'external') {
      throw NetSuiteError.badRequest(
        'INVALID_OPERATION',
        'PUT is an upsert and needs an external ID: /{type}/eid:{externalId}. Use PATCH to update by internal ID.',
      );
    }
    const { record } = await this.records.upsert(type, id.externalId, body);
    res.location(recordUrl(req, record));
  }

  @Delete(':type/:id')
  @HttpCode(204)
  async remove(@Param('type') rawType: string, @Param('id') rawId: string): Promise<void> {
    const type = parseType(rawType);
    const id = parseId(rawId);
    const internalId =
      id.kind === 'internal' ? id.id : (await this.records.getByExternalId(type, id.externalId)).id;
    await this.records.delete(type, internalId);
  }
}

function parseType(raw: string): RecordType {
  const type = toRecordType(raw);
  if (!type) throw NetSuiteError.notFound(`Record type '${raw}' does not exist`, 'RECORD_TYPE_NOT_FOUND');
  return type;
}

function parseId(raw: string): RecordId {
  if (raw.startsWith('eid:')) {
    const externalId = raw.slice(4);
    if (!externalId) throw NetSuiteError.badRequest('INVALID_CONTENT', 'External ID is empty');
    return { kind: 'external', externalId };
  }
  if (/^\d+$/.test(raw)) return { kind: 'internal', id: raw };
  throw NetSuiteError.badRequest(
    'INVALID_CONTENT',
    `'${raw}' is not a valid record ID. Use a number or eid:<externalId>.`,
  );
}
