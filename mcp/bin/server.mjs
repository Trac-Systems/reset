#!/usr/bin/env node
import { createMcpService } from '../lib/server.mjs';
try {
  const service = await createMcpService({ gatewayUrl: process.env.RESET_GATEWAY_URL,
    publicOrigin: process.env.RESET_MCP_ORIGIN || undefined });
  const url = await service.listen({ host: process.env.RESET_MCP_HOST ?? '127.0.0.1', port: Number(process.env.RESET_MCP_PORT ?? 3100) });
  console.log(JSON.stringify({ listening: url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close());
} catch (error) { console.error(error.message); process.exitCode = 1; }
