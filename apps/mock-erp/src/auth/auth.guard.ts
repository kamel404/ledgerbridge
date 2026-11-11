import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC } from '../common/public.decorator.js';
import { NetSuiteError } from '../common/netsuite-error.js';
import { TokenService } from './token.service.js';

/**
 * Runs before every route (registered globally). Requires
 * `Authorization: Bearer <token>` unless the route is marked @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const header = context.switchToHttp().getRequest<Request>().headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new NetSuiteError(401, 'INVALID_LOGIN', 'Missing Authorization: Bearer <token> header');
    }
    await this.tokens.verify(header.slice(7).trim());
    return true;
  }
}
