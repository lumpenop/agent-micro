const assert = require('assert');
const settings = require('../src/codex-settings');

const remote = settings.normalize({
  api_base_url: 'https://provider.example/v1',
  api_model: 'provider-model',
  api_key_env: 'PROVIDER_API_KEY',
  model: 'openai-model-that-must-not-override',
});
const remoteToml = settings.profileToml(remote);
assert.match(remoteToml, /wire_api = "responses"/);
assert.match(remoteToml, /env_key = "PROVIDER_API_KEY"/);
assert.equal((remoteToml.match(/^model = /gm) || []).length, 1);
assert.match(remoteToml, /^model = "provider-model"$/m);
assert.ok(!remoteToml.includes('wire_api = "chat"'));
const remoteArgs = settings.cliConfigArgs(remote).filter(Boolean);
assert.ok(remoteArgs.includes('model_provider="agent-micro-custom"'));
assert.ok(remoteArgs.includes('model="provider-model"'));
assert.ok(!remoteArgs.includes('model="openai-model-that-must-not-override"'));

const localToml = settings.profileToml(settings.normalize({
  api_base_url: 'http://127.0.0.1:11434/v1',
  api_model: 'local-model',
}));
assert.match(localToml, /wire_api = "responses"/);
assert.ok(!localToml.includes('env_key ='), 'loopback providers should allow no-auth operation');

process.stdout.write('Codex Responses provider configuration: ok\n');
