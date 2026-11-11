import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ChaosService } from './chaos.service.js';

/** Applies chaos to ERP API routes (/services/rest/...), before auth and handlers run. */
@Injectable()
export class ChaosMiddleware implements NestMiddleware {
  constructor(private readonly chaos: ChaosService) {}

  use(_req: Request, _res: Response, next: NextFunction): void {
    this.chaos.beforeRequest().then(() => next(), next);
  }
}
