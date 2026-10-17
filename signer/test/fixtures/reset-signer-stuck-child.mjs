// A chat process that registers but never applies a mode change and ignores SIGTERM: the owner's switch must still stop it.
import { register } from '../../lib/chat-mode.mjs';
register('chat-agent', process.env.RESET_SIGNER_DIRECTORY);
process.on('SIGTERM', () => {});
process.stderr.write('STUCK_READY\n');
setInterval(() => {}, 1000);
