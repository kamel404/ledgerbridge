import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  it('reports ok for this service', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    const result = moduleRef.get(HealthController).check();

    expect(result).toMatchObject({ status: 'ok', service: 'mock-erp' });
  });
});
