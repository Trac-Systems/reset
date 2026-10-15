import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { publicAddress, signChallenge } from 'reset-signer';
export async function post(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
export async function connectAgent(url, wallet) {
  const challenge = await (await post(`${url}/auth/challenge`, { address: publicAddress(wallet) })).json();
  const response = await post(`${url}/auth/login`, signChallenge(wallet, challenge, { audience: url }));
  const login = await response.json();
  if (!response.ok) throw new Error(login.error);
  const client = new Client({ name: 'reset-e2e-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${login.token}` } } }));
  return { client, login, call: async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    const text = result.content[0].text;
    return name === 'reset_rules' ? text : JSON.parse(text);
  } };
}
