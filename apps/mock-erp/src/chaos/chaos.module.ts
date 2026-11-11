import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ChaosController } from './chaos.controller.js';
import { ChaosMiddleware } from './chaos.middleware.js';
import { CHAOS_CLOCK, ChaosService, systemClock } from './chaos.service.js';

@Module({
  controllers: [ChaosController],
  providers: [ChaosService, { provide: CHAOS_CLOCK, useValue: systemClock }],
})
export class ChaosModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ChaosMiddleware).forRoutes('services/rest/*path');
  }
}
