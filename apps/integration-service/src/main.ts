import { createApp } from './app.factory.js';

const app = await createApp();
await app.listen(process.env.INTEGRATION_SERVICE_PORT ?? 3000);
