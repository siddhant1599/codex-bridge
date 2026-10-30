import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { authorized, chunks, codexArgs, config, lock, runCodex, Store, secretRedactor } from '../src/core.js';
import { Telegram } from '../src/telegram.js';

test('only the configured human in a private chat is authorized', () => {
  const message = { from: { id: 123 }, chat: { id: 123, type: 'private' } };
  assert.equal(authorized(message, '123'), true);
  assert.equal(authorized(message, ''), false);
  assert.equal(authorized(message, '456'), false);
  assert.equal(authorized({ ...message, chat: { id: 123, type: 'group' } }, '123'), false);
  assert.equal(authorized({ ...message, from: { id: 123, is_bot: true } }, '123'), false);
  assert.equal(authorized(undefined, '123'), false);
});

test('rejects missing credentials and unsafe sandbox configuration', () => {
  assert.throws(() => config({}), /TOKEN/);
  assert.throws(() => config({ TELEGRAM_BOT_TOKEN: '123:abc', CODEX_SANDBOX: 'danger-full-access' }), /SANDBOX/);
});

test('full access requires explicit opt-in and GitHub credentials stay out of arguments', () => {
  const env = { TELEGRAM_BOT_TOKEN: '123:abc', CODEX_SANDBOX: 'danger-full-access', CODEX_ALLOW_FULL_ACCESS: 'true', GH_TOKEN: 'test-github-secret' };
  const cfg = config(env);
  assert.equal(cfg.sandbox, 'danger-full-access');
  for (const thread of [null, 'existing-thread']) {
    const args = codexArgs(cfg, thread);
    assert.ok(args.includes('sandbox_mode="danger-full-access"'));
    assert.ok(args.some(arg => arg.includes('include_only=') && arg.includes('GH_TOKEN')));
    assert.ok(!args.join(' ').includes(env.GH_TOKEN));
  }
  const redact = secretRedactor(env);
  assert.equal(redact('123:abc test-github-secret'), '[REDACTED] [REDACTED]');
  assert.equal(secretRedactor({})('ordinary text'), 'ordinary text');
  assert.equal(config({ TELEGRAM_BOT_TOKEN: '123:abc' }).sandbox, 'workspace-write');
});

test('splits long replies without corrupting emoji', () => {
  const text = 'a'.repeat(3999) + '😀'.repeat(3000);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => part.length <= 4000 && part.isWellFormed()));
});

test('state survives restarts and locks prevent concurrent polling', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.save({ offset: 10, thread: 'session' });
  assert.equal(new Store(dir).data.thread, 'session');
  assert.equal(new Store(dir).data.offset, 10);
  const release = lock(dir);
  assert.throws(() => lock(dir), /lock exists/);
  release();
  lock(dir)();
});

test('resume targets the explicit thread and preserves restrictions', () => {
  const args = codexArgs({ sandbox: 'workspace-write', model: '' }, 'thread-id');
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.deepEqual(args.slice(4), ['exec', 'resume', 'thread-id', '--json', '--skip-git-repo-check', '-']);
  assert.ok(!args.includes('--last'));
});

test('startup automatically replaces a lock from an exited process', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.lock');
  writeFileSync(path, '12345');
  const logs = [];
  const release = lock(dir, { probe: pid => {
    assert.equal(pid, 12345);
    throw Object.assign(new Error('Process exited'), { code: 'ESRCH' });
  }, log: message => logs.push(message) });
  assert.equal(readFileSync(path, 'utf8'), String(process.pid));
  assert.match(logs[0], /Removed stale/);
  release();
  release();
  assert.throws(() => readFileSync(path), { code: 'ENOENT' });
});

test('startup preserves unverifiable and malformed locks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-preserve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.lock');
  writeFileSync(path, '12345');
  assert.throws(() => lock(dir, { probe: () => { throw Object.assign(new Error('Denied'), { code: 'EPERM' }); } }), /Cannot verify/);
  assert.equal(readFileSync(path, 'utf8'), '12345');
  writeFileSync(path, '');
  assert.throws(() => lock(dir), /no valid PID/);
  assert.equal(readFileSync(path, 'utf8'), '');
});

test('exiting an old instance does not remove a replacement lock', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-replaced-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.lock');
  const release = lock(dir);
  renameSync(path, join(dir, 'previous.lock'));
  writeFileSync(path, String(process.pid));
  release();
  assert.equal(readFileSync(path, 'utf8'), String(process.pid));
  unlinkSync(path);
});

function fixture(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fake.cjs');
  writeFileSync(path, script);
  return { cfg: { bin: process.execPath, cwd: dir, sandbox: 'read-only', timeout: 5 },
    spawn: (_bin, _args, options) => spawn(process.execPath, [path], options) };
}

test('model selection is passed explicitly to new and resumed CLI tasks', () => {
  for (const thread of [null, 'saved-session']) {
    const args = codexArgs({ sandbox: 'workspace-write', model: 'test-model' }, thread);
    assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  }
  assert.ok(!codexArgs({ sandbox: 'workspace-write', model: '' }, 'saved-session').includes('--model'));
});

test('runner reads actual child JSONL, persists ID, and passes prompt via stdin', async t => {
  const f = fixture(t, `let input=''; process.stdin.on('data', x=>input+=x); process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'thread.started',thread_id:'abc'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}}));
  });`);
  let id;
  const job = runCodex(f.cfg, null, 'literal $(touch nope) " text', value => { id = value; }, f.spawn);
  assert.equal(await job.done, 'literal $(touch nope) " text');
  assert.equal(id, 'abc');
});

test('runner reports turn failure even with exit code zero', async t => {
  const f = fixture(t, `console.log(JSON.stringify({type:'turn.failed',error:{message:'Quota reached'}}));`);
  await assert.rejects(runCodex(f.cfg, null, 'hi', () => {}, f.spawn).done, /Quota reached/);
});

test('runner terminates timed out jobs', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  f.cfg.timeout = 0.1;
  await assert.rejects(runCodex(f.cfg, null, 'hi', () => {}, f.spawn).done, /timed out/);
});

test('Telegram sends plain text chunks and never exposes token in network errors', async () => {
  const sent = [];
  const api = new Telegram('secret-token', async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: {} }) };
  });
  await api.send('123', 'x'.repeat(5000));
  assert.deepEqual(sent.map(x => x.text.length), [4000, 1000]);
  assert.equal(sent[0].parse_mode, undefined);
  const broken = new Telegram('secret-token', async () => { throw new Error('secret-token'); });
  await assert.rejects(broken.call('getMe'), error => !error.message.includes('secret-token'));
});
