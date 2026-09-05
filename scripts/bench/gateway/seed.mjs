// Run only against an orchestrator-created empty sandbox, before gateway launch.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.DATA_DIR;
if (!dir || !path.isAbsolute(dir) || !fs.existsSync(path.join(dir, '.gateway-benchmark'))) throw Error('sandbox marker required');
const { createProviderNode } = await import('../../../src/lib/db/repos/nodesRepo.js');
const { createProviderConnection } = await import('../../../src/lib/db/repos/connectionsRepo.js');
const { createApiKey } = await import('../../../src/lib/db/repos/apiKeysRepo.js');
const { updateSettings } = await import('../../../src/lib/db/repos/settingsRepo.js');
const { createProxyPool } = await import('../../../src/lib/db/repos/proxyPoolsRepo.js');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [prefix, url] of Object.entries(config.upstreams)) {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || ['20127','20128'].includes(u.port)) throw Error('unsafe upstream');
  const node = await createProviderNode({id:'openai-compatible-'+prefix,type:'openai-compatible',name:prefix,prefix,apiType:'chat',baseUrl:url});
  await createProviderConnection({provider:node.id,authType:'apikey',name:prefix,apiKey:'benchmark-only',isActive:true,providerSpecificData:{baseUrl:url,apiType:'chat',...(config.proxy ? {proxyPoolId:'bench-pool'} : {})}});
}
if (config.proxy) await createProxyPool({id:'bench-pool',name:'bench',proxyUrl:config.proxy,isActive:true,strictProxy:true});
await updateSettings({requireApiKey:true,enableObservability:false,rtkEnabled:false,headroomEnabled:false,pxpipeEnabled:false});
const key = await createApiKey('bench-client','bench-machine');
fs.writeFileSync(process.argv[3], JSON.stringify({key:key.key}), {mode:0o600});
process.exit(0);
