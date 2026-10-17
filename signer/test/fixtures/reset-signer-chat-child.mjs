// A real chat agent process for the mode tests: real wallet, gateway client, guard and mode handling; a scripted model.
import { unlock } from '../../lib/keystore.mjs';
import { localBackend } from '../../lib/local-backend.mjs';
import { createGuard } from '../../lib/chat-guard.mjs';
import { runChatAgent } from '../../lib/agent.mjs';
const { RESET_SIGNER_DIRECTORY: directory, RESET_SIGNER_PASSWORD: password, RESET_GATEWAY_URL: gatewayUrl, CHILD_SAY: say } = process.env;
const wallet = await unlock({ directory, password });
const backend = localBackend({ wallet, gatewayUrl });
let spoke = false;
const model = { async complete() { if (spoke) return []; spoke = true; return [{ name: 'chat_send', args: { text: say } }]; } };
await runChatAgent({ wallet, backend, guard: createGuard({ wallet }), directory, model, everyMs: 100, log: t => process.stderr.write(t + '\n') });
process.stderr.write('CHILD_DONE\n');
