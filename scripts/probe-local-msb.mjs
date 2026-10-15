import {localNetwork,until} from '../tests/helpers/local-network.mjs';
import {applyStateMessageFactory} from 'trac-msb/src/messages/state/applyStateMessageFactory.js';
const local=await localNetwork();
try {
  const b=await local.msb();const c=await local.client(b);const p=await local.peer('admin',c);
  await local.fund(b,p.wallet);await until(()=>c.state.getNodeEntry(p.wallet.address),'client fund');
  const partial=await applyStateMessageFactory(p.wallet,c.config).buildPartialBootstrapDeploymentMessage(p.wallet.address,p.base.key,p.config.channel,await c.state.getIndexerSequenceState(),'json');
  console.log('DEPLOY',await c.network.validatorMessageOrchestrator.send(partial));
  await until(()=>b.state.getRegisteredBootstrapEntry(p.base.key.toString('hex')),'deployment',20000);
  console.log('DEPLOYED');
} finally {await local.close();}
