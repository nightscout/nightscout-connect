#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { accountsFrom, check } = require('./librelinkup-lab/common');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, '.local/librelinkup');
const envPath = path.join(dir, '.env');
const image = 'librelinkup-validation-nightscout:59430336';
const nsCommit = '59430336dac0d75cdc7622725225b7ab774d788e';
const composePath = path.join(dir, 'compose.json');
function command(cmd, args, quiet = false) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: quiet ? 'pipe' : 'inherit' });
  check(result.status === 0, 'LOCAL_COMMAND_FAILED');
  return result.stdout?.toString().trim();
}
function compose(args, quiet = false) { return command('docker', ['compose', '-f', composePath, ...args], quiet); }
function setup() {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'results'), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(envPath)) fs.copyFileSync(path.join(root, 'docs/librelinkup-lab.env.example'), envPath);
  fs.chmodSync(envPath, 0o600);
  if (!fs.existsSync(path.join(dir, 'secret'))) fs.writeFileSync(path.join(dir, 'secret'), crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  const secret = fs.readFileSync(path.join(dir, 'secret'), 'utf8');
  const accounts = accountsFrom(fs.readFileSync(envPath, 'utf8'));
  const base = { image, init: true, restart: 'no', logging: { driver: 'none' },
    volumes: [`${root}:/opt/app/node_modules/nightscout-connect:ro`],
    depends_on: { mongo: { condition: 'service_healthy' } } };
  const services = {
    mongo: { image: 'mongo:6.0.27', restart: 'no', logging: { driver: 'none' },
      volumes: ['data:/data/db'], healthcheck: { test: ['CMD', 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok'], interval: '3s', timeout: '5s', retries: 30 } },
    runner: { ...base, user: 'root', command: ['node', '-e', 'setInterval(()=>{}, 3600000)'],
      environment: { LLU_LAB_SECRET: secret },
      volumes: [...base.volumes, `${dir}/results:/lab-results`] }
  };
  for (const account of [...accounts, { id: 'fixture', port: 1369, units: 'mmol', timezone: 'UTC' }]) {
    services[account.id] = { ...base, ports: [`127.0.0.1:${account.port}:1337`], environment: {
      MONGO_CONNECTION: `mongodb://mongo:27017/librelinkup_validation_${account.id}`,
      API_SECRET: secret, INSECURE_USE_HTTP: 'true', AUTH_DEFAULT_ROLES: 'readable',
      ENABLE: 'careportal sage', CONNECT_SOURCE: '', CONNECT_DEBUG: 'false',
      DISPLAY_UNITS: account.units, TZ: account.timezone, TIME_FORMAT: '24',
      CUSTOM_TITLE: `LibreLinkUp test - ${account.id}`, ALARM_HIGH: 'off', ALARM_LOW: 'off',
      ALARM_URGENT_HIGH: 'off', ALARM_URGENT_LOW: 'off', ALARM_TIMEAGO_WARN: 'off', ALARM_TIMEAGO_URGENT: 'off'
    } };
  }
  fs.writeFileSync(composePath, JSON.stringify({ name: 'librelinkup-validation', services, volumes: { data: {} } }, null, 2), { mode: 0o600 });
  return accounts;
}
function imageExists() {
  return spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
}
async function main() {
  const action = process.argv[2] || 'help';
  if (action === 'help') {
    console.log('Usage: npm run test:librelinkup:lab -- setup|build|up|status|stop|fixture|probe|run [account-alias]');
    return;
  }
  check(['setup', 'build', 'up', 'status', 'stop', 'fixture', 'probe', 'run'].includes(action), 'UNKNOWN_ACTION');
  const accounts = setup();
  if (action === 'setup') { console.log(`Private account settings: ${envPath}`); return; }
  if (action === 'build') {
    const src = path.join(dir, 'nightscout-src');
    if (!fs.existsSync(src)) command('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/nightscout/cgm-remote-monitor.git', src]);
    command('git', ['-C', src, 'fetch', '--depth=1', 'origin', nsCommit]);
    command('git', ['-C', src, 'checkout', '--detach', nsCommit]);
    command('docker', ['build', '--tag', image, src]);
    return;
  }
  if (action === 'stop') { compose(['down']); return; }
  if (action === 'status') {
    compose(['ps']);
    for (const a of accounts) console.log(`${a.id}: http://127.0.0.1:${a.port} (${a.username && a.password ? 'configured' : 'credentials not configured'}; ${a.region}: ${a.endpoint})`);
    return;
  }
  check(imageExists(), 'BUILD_NIGHTSCOUT_IMAGE_FIRST');
  if (action === 'up') {
    compose(['up', '-d', '--wait']);
    for (const a of accounts) console.log(`${a.id}: http://127.0.0.1:${a.port}`);
    return;
  }
  const alias = process.argv[3];
  check(!alias || accounts.some(a => a.id === alias), 'UNKNOWN_ACCOUNT_ALIAS');
  const selected = alias ? accounts.filter(a => a.id === alias) : accounts.filter(a => a.username || a.password);
  check(action === 'fixture' || selected.length > 0, 'NO_CONFIGURED_ACCOUNTS');
  // Only start the runner here. UI services are started/restarted after writes,
  // so their in-memory cache loads the verified stored snapshot.
  compose(['up', '-d', '--wait', 'runner']);
  const args = ['exec', '-T', 'runner', 'node', '/opt/app/node_modules/nightscout-connect/scripts/librelinkup-lab/runner.js',
    ...(action === 'fixture' ? ['--fixture'] : ['--live', ...(action === 'probe' ? ['--probe'] : []),
      `--env-file=/opt/app/node_modules/nightscout-connect/.local/librelinkup/.env`, ...(alias ? [`--account=${alias}`] : [])])];
  // No account values or source errors pass through child-process arguments.
  let failed = false;
  try { compose(args); } catch { failed = true; }
  if (action !== 'probe') {
    const names = action === 'fixture' ? ['fixture'] : selected.map(a => a.id);
    compose(['up', '-d', ...names]);
    compose(['restart', ...names]);
  }
  check(!failed, 'VALIDATION_FAILED_SEE_REDACTED_RESULTS');
}
if (require.main === module) main().catch(error => {
  console.error(error.labCode || 'LOCAL_LAB_FAILED');
  process.exitCode = 1;
});
