const assert = require('assert');
const EventEmitter = require('events');
const { CodexBridge } = require('../src/providers/codex-bridge');

(async () => {
  const bridge = new CodexBridge({
    heartbeatFailureLimit: 2,
    reconnectDelays: [0],
  });
  const proc = new EventEmitter();
  proc.killCount = 0;
  proc.kill = () => { proc.killCount += 1; };
  bridge.proc = proc;
  bridge.connected = true;
  bridge.mode = 'stdio';
  bridge._reconnectEnabled = true;

  let reconnectScheduled = 0;
  bridge._scheduleReconnect = () => { reconnectScheduled += 1; };

  bridge._recordHeartbeatFailure(new Error('first timeout'));
  assert.equal(bridge.connected, true, 'one transient heartbeat failure must not disconnect');

  bridge._recordHeartbeatFailure(new Error('second timeout'));
  assert.equal(bridge.connected, false, 'consecutive heartbeat failures must mark the bridge offline');
  assert.equal(bridge.mode, 'offline');
  assert.equal(proc.killCount, 1, 'unresponsive app-server must be terminated');
  assert.equal(reconnectScheduled, 1, 'unexpected disconnect must schedule reconnect');

  const reconnecting = new CodexBridge({ reconnectDelays: [0] });
  reconnecting._reconnectEnabled = true;
  let starts = 0;
  reconnecting.start = async () => {
    starts += 1;
    reconnecting.connected = true;
    return true;
  };
  reconnecting._scheduleReconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(starts, 1, 'scheduled reconnect must restart the app-server');
  assert.equal(reconnecting.connected, true);
  reconnecting.stop();

  process.stdout.write('Codex heartbeat disconnect + auto reconnect: ok\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
