import { configure as serverlessExpress } from '@codegenie/serverless-express';
import type { Express } from 'express';
import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createApp } from '../app.factory.js';

// Lambda entry point for HTTP routes behind API Gateway.
// The app is built once per container (cold start) and reused while warm.
type ProxyHandler = ReturnType<typeof serverlessExpress>;
let cached: ProxyHandler | undefined;

async function bootstrap(): Promise<ProxyHandler> {
  const app = await createApp();
  await app.init();
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  return serverlessExpress({ app: expressApp });
}

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  cached ??= await bootstrap();
  return (await cached(event, context, () => undefined)) as APIGatewayProxyResultV2;
};
