import { createApp } from './app.factory.js';

const app = await createApp();
await app.listen(process.env.MOCK_ERP_PORT ?? 3001);
