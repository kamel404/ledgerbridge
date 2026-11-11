import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator.js';
import { HealthService, type HealthStatus } from './health.service.js';

@Controller('health')
export class HealthController {
  // Injected by Nest. If decorator metadata is lost in a bundle, this is
  // undefined at runtime, which is exactly what the Lambda smoke test catches.
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  check(): HealthStatus {
    return this.health.check();
  }
}
