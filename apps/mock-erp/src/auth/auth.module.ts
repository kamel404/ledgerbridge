import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { TokenController } from './token.controller.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [TokenController],
  providers: [TokenService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenService],
})
export class AuthModule {}
