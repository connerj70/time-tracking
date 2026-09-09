import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { createApp } from './http/app.js';

async function main() {
  await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`${config.productName} listening on ${config.baseUrl}`);
    console.log(`  MCP:   ${config.mcpUrl}`);
    console.log(`  OAuth: ${config.authIssuerUrl}/.well-known/oauth-authorization-server`);
    console.log(`  App:   ${config.appUrl}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
