import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';

export async function connectLocal({ directory, password, gatewayUrl, mcpUrl, contextFile, headerSource, flags = [], command, args, env = {} }) {
  const logs = [], outputs = [], progress = [];
  const client = new Client({ name: 'reset-local-test', version: '1.0.0' });
  client.setNotificationHandler(LoggingMessageNotificationSchema, message => { logs.push(message.params.data); });
  const transport = new StdioClientTransport({
    command: command ?? process.execPath,
    args: args ?? [fileURLToPath(new URL('../bin/reset-signer.mjs', import.meta.url)), 'mcp', ...flags],
    env: { ...process.env, RESET_SIGNER_DIRECTORY: directory, RESET_SIGNER_PASSWORD: password,
      RESET_GATEWAY_URL: gatewayUrl ?? '', RESET_MCP_URL: mcpUrl ?? '', RESET_SIGNER_CONTEXT: contextFile ?? '', RESET_HEADER_SOURCE: headerSource ?? '',
      npm_config_userconfig: '/dev/null', npm_config_cache: fileURLToPath(new URL('../../.npm-cache/', import.meta.url)),
      npm_config_prefer_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', ...env }, stderr: 'pipe'
  });
  transport.stderr.on('data', chunk => logs.push(chunk.toString()));
  try { await client.connect(transport); } catch (error) { await transport.close(); throw error; }
  const result = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120000, onprogress: info => progress.push(info) });
    outputs.push(response); return response;
  };
  return { client, transport, logs, outputs, progress, result,
    async call(name, args = {}) {
      const response = await result(name, args);
      if (response.isError) throw new Error(response.content[0].text);
      try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
    }, close: () => client.close() };
}
