import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  service: string;
  timestamp: string;
}

@Injectable()
export class HealthService {
  check(): HealthStatus {
    return {
      status: 'ok',
      service: 'integration-service',
      timestamp: new Date().toISOString(),
    };
  }
}
