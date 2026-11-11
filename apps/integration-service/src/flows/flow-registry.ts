import { Inject, Injectable } from '@nestjs/common';
import type { EventType, LedgerEvent } from '@ledgerbridge/shared';
import { PermanentError } from '../errors/integration-errors.js';
import { FLOW_HANDLERS, type FlowHandler, type FlowResult } from './flow-handler.js';

/**
 * Maps event type -> handler and runs the right one. `processEvent` is the
 * core of the worker: today the webhook calls it directly, from Phase 4 the
 * SQS worker does.
 */
@Injectable()
export class FlowRegistry {
  private readonly handlers = new Map<EventType, FlowHandler>();

  constructor(@Inject(FLOW_HANDLERS) handlers: FlowHandler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.eventType)) {
        throw new Error(`Two flow handlers registered for ${handler.eventType}`);
      }
      this.handlers.set(handler.eventType, handler);
    }
  }

  supports(type: string): boolean {
    return this.handlers.has(type as EventType);
  }

  async processEvent(event: LedgerEvent): Promise<FlowResult> {
    const handler = this.handlers.get(event.type) as FlowHandler<typeof event.type> | undefined;
    if (!handler) {
      throw new PermanentError('UNSUPPORTED_EVENT_TYPE', `No flow handles events of type ${event.type}`);
    }
    return handler.handle(event as never);
  }
}
