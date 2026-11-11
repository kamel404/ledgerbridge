import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.factory.js';

// Local runs read the repo-root .env (dist/main.js -> ../../../.env).
// On Lambda, settings come from the function's environment instead.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = process.env.INTEGRATION_SERVICE_PORT ?? 3000;
const app = await createApp();
await app.listen(port);
console.log(`Integration service listening on http://localhost:${port}`);
