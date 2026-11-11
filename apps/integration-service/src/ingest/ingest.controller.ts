import { Controller, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { WebhookSource } from '../secrets/secrets-provider.js';
import { IngestService } from './ingest.service.js';
import { rawBodyOf } from './raw-body.js';
import { WebhookSignatureGuard } from './webhook-signature.guard.js';

/**
 * POST /webhooks/billing      (O2C: invoice.created, payment.received)
 * POST /webhooks/procurement  (P2P: bill.approved)
 *
 * WebhookSignatureGuard has already checked the source and the signature.
 */
@Controller('webhooks')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post(':source')
  @HttpCode(202)
  @UseGuards(WebhookSignatureGuard)
  async receive(
    @Param('source') source: WebhookSource,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object> {
    const result = await this.ingest.ingest(source, rawBodyOf(req));
    res.status(result.httpStatus);
    return result.body;
  }
}
