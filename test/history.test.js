import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { History, readHistory } from '../src/history.js';
import { dashboardHandler } from '../src/dashboard.js';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('archives conversations across restarts, redacts secrets, and resumes the right thread', t => {
  const directory = temporary(t);
  const logs = [];
  const history = new History(directory, { redact: text => text.replaceAll('secret', '[REDACTED]'), log: text => logs.push(text) });
  const first = history.select(null, { project: '/project' });
  history.add(first, 'user', 'Explain this project secret');
  history.update(first, { thread: 'thread-one', status: 'working' });
  const reply = history.add(first, 'assistant', '\x1b[31mA reply');
  history.delivery(first, reply, 'failed');
  const second = history.select(null, { fresh: true });
  assert.notEqual(first, second);
  history.add(second, 'user', 'A separate conversation');
  const restarted = new History(directory, { log: () => {} });
  assert.equal(restarted.select('thread-one'), first);
  const data = readHistory(directory);
  assert.equal(data.conversations.length, 2);
  assert.equal(data.conversations[0].status, 'interrupted');
  assert.equal(data.conversations[0].messages[1].delivery, 'failed');
  assert.ok(!readFileSync(join(directory, 'history.json'), 'utf8').includes('secret'));
  assert.ok(logs.every(text => !text.includes('\x1b')));
});

test('dashboard handler serves history and assets but blocks foreign origins and arbitrary files', async t => {
  const directory = temporary(t);
  const history = new History(directory, { log: () => {} });
  history.add(history.select(), 'user', '<script>alert("untrusted")</script>');
  const handler = dashboardHandler({ directory, port: 8787 });
  async function request(url, headers = {}, method = 'GET') {
    const result = { status: 200, headers: {}, body: '',
      setHeader(key, value) { this.headers[key] = value; },
      writeHead(status) { this.status = status; return this; },
      end(body = '') { this.body = String(body); return this; } };
    await handler({ url, method, headers: { host: '127.0.0.1:8787', ...headers } }, result);
    return result;
  }
  const response = await request('/api/history');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).conversations[0].messages.length, 1);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  for (const path of ['/', '/app.js', '/style.css']) assert.equal((await request(path)).status, 200);
  for (const path of ['/.env', '/src/main.js', '/.bridge/history.json']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/api/history', { origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/api/history', { host: 'attacker.example' })).status, 403);
  assert.equal((await request('/api/history', {}, 'POST')).status, 405);
});

test('dashboard submissions validate origin, size, input, archive mode and busy responses', async t => {
  const directory = temporary(t);
  const submitted = [];
  const handler = dashboardHandler({ directory, port: 8787, submit: async data => {
    if (data.text === 'busy') throw Object.assign(new Error('Codex is working'), { status: 409 });
    submitted.push(data); return { conversationId: data.conversationId };
  } });
  async function post(body, headers = {}, target = handler) {
    const req = Readable.from([body]);
    Object.assign(req, { url: '/api/message', method: 'POST', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'x-bridge-request': '1', 'content-type': 'application/json', ...headers } });
    const res = { status: 200, setHeader() {}, writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; } };
    await target(req, res); return res;
  }
  const body = JSON.stringify({ conversationId: 'selected', text: 'Continue here' });
  assert.equal((await post(body)).status, 200);
  assert.deepEqual(submitted, [{ conversationId: 'selected', text: 'Continue here' }]);
  assert.equal((await post(body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(body, { 'x-bridge-request': '' })).status, 403);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post(JSON.stringify({ conversationId: 'selected', text: '  ' }))).status, 400);
  assert.equal((await post('x'.repeat(17000))).status, 413);
  assert.equal((await post(JSON.stringify({ conversationId: 'selected', text: 'busy' }))).status, 409);
  assert.equal((await post(body, {}, dashboardHandler({ directory, port: 8787 }))).status, 503);
  assert.equal(submitted.length, 1);
});

test('bridge handles Telegram and dashboard requests, including resuming a selected older conversation', async t => {
  const directory = temporary(t);
  const fake = join(directory, 'codex.cjs');
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('status')) process.exit(0);
// Exercise startup when model discovery is unavailable, without recording a task.
if (process.argv.includes('debug')) process.exit(1);
require('node:fs').appendFileSync('invocations.jsonl',JSON.stringify(process.argv)+String.fromCharCode(10));
process.stdin.resume();
let prompt='';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
require('node:fs').appendFileSync('prompts.jsonl',JSON.stringify(prompt)+String.fromCharCode(10));
console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'A test reply'}}));
});
`);
  chmodSync(fake, 0o700);
  const preload = join(directory, 'telegram.mjs');
  writeFileSync(preload, `import { Server } from 'node:http';
import { Readable } from 'node:stream';
import { appendFileSync } from 'node:fs';
// Stub only socket binding, since this test exercises the bridge lifecycle offline.
Server.prototype.listen = function(port, host, ready) {
 this.address = () => ({port:8787});
 const handler = this.listeners('request')[0];
 process.on('message', async data => {
   const req = Readable.from([JSON.stringify(data.body)]);
   Object.assign(req,{url:'/api/message',method:'POST',headers:{host:'127.0.0.1:8787',origin:'http://127.0.0.1:8787','x-bridge-request':'1','content-type':'application/json'}});
   const res={status:200,setHeader(){},writeHead(status){this.status=status;return this;},end(body){process.send({id:data.id,status:this.status,body:JSON.parse(body)});}};
   await handler(req,res);
 });
 queueMicrotask(ready); return this;
};
let delivered=false;
globalThis.fetch = async (url, options) => {
 const method=url.split('/').at(-1);
 let result={};
 if(method==='sendMessage') {
   const message=JSON.parse(options.body);
   appendFileSync('telegram-sent.jsonl',JSON.stringify(message)+String.fromCharCode(10));
   if(message.text.startsWith('You · Dashboard')) await new Promise(resolve=>setTimeout(resolve,120));
   if(message.text.includes('Offline mirror example')) return {json:async()=>({ok:false,error_code:403})};
 }
 if(method==='getMe') result={id:999,username:'test_bot'};
 if(method==='getUpdates') {
   await new Promise(resolve=>setTimeout(resolve,80));
   result=delivered?[]:[{update_id:1,message:{chat:{type:'private',id:123},from:{id:123},text:'Explain my code'}}];
   delivered=true;
 }
 return {json:async()=>({ok:true,result})};
};`);
  const child = spawn(process.execPath, ['--import', preload, resolve('src/main.js')], {
    cwd: directory,
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '999:fake', TELEGRAM_ALLOWED_USER_ID: '123', CODEX_BIN: fake, CODEX_WORKDIR: directory, CODEX_SANDBOX: 'read-only', CODEX_TIMEOUT_SECONDS: '10', CODEX_MODEL: '', DASHBOARD_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let data;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    data = readHistory(join(directory, '.bridge'));
    if (data.conversations[0]?.messages.some(m => m.text === 'A test reply' && m.delivery === 'sent')) break;
  }
  assert.ok(data.conversations[0]?.messages.some(m => m.text === 'Explain my code'), output);
  assert.ok(data.conversations[0]?.messages.some(m => m.text === 'A test reply' && m.delivery === 'sent'), output);
  assert.equal(data.conversations[0].status, 'completed');
  assert.equal(data.conversations[0].thread, 'test-session');
  assert.match(output, /You · Telegram/);
  assert.match(output, /Could not load Codex model list:/);
  assert.match(output, /A test reply/);
  let sequence = 0;
  function send(text, conversationId) {
    const id = ++sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Dashboard response timed out')); }, 3000);
      const receive = result => { if (result.id === id) { clearTimeout(timer); child.off('message', receive); resolvePromise(result); } };
      child.on('message', receive);
      child.send({ id, body: { text, conversationId } });
    });
  }
  const originalId = data.conversations[0].id;
  const initialPrompt = JSON.parse(readFileSync(join(directory, 'prompts.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.match(initialPrompt, /Bridge agent mode: auto/);
  assert.match(initialPrompt, /You are code-bot-sid/);
  assert.ok(initialPrompt.endsWith('Explain my code'));
  const fresh = await send('/new', originalId);
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.conversationId, originalId);
  const modelChange = await send('/model test-model', originalId);
  assert.equal(modelChange.status, 200);
  assert.equal(readHistory(join(directory, '.bridge')).conversations[0].model, 'test-model');
  await send('/model --bad extra', originalId);
  assert.equal(readHistory(join(directory, '.bridge')).conversations[0].model, 'test-model');
  await send('/model', originalId);
  assert.ok(readHistory(join(directory, '.bridge')).conversations[0].messages.some(m => m.role === 'system' && m.text.startsWith('Current model: test-model')));
  await send('/agent coding', originalId);
  await send('/agent invalid', originalId);
  assert.equal(readHistory(join(directory, '.bridge')).conversations[0].agentMode, 'coding');
  const submitted = await send('Continue the older conversation', originalId);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.conversationId, originalId);
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    data = readHistory(join(directory, '.bridge'));
    if (data.conversations[0].messages.some(m => m.role === 'assistant' && m.source === 'dashboard' && m.delivery === 'sent')) break;
  }
  assert.ok(data.conversations[0].messages.some(m => m.text === 'Continue the older conversation' && m.source === 'dashboard'));
  assert.ok(data.conversations[0].messages.some(m => m.role === 'assistant' && m.source === 'dashboard' && m.delivery === 'sent'));
  assert.ok(data.conversations[0].messages.some(m => m.text === 'Continue the older conversation' && m.delivery === 'sent'));
  const sentMessages = readFileSync(join(directory, 'telegram-sent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).text);
  assert.deepEqual(sentMessages.slice(-3), ['You · Dashboard\n\nContinue the older conversation', 'Working on your request…', 'A test reply']);
  assert.ok(!sentMessages.some(text => text.includes('Explain my code')), 'Telegram-origin messages must not be echoed');
  assert.equal(data.conversations[0].messages.filter(m => m.text === 'Continue the older conversation').length, 1);
  assert.equal(data.currentId, originalId);
  const args = JSON.parse(readFileSync(join(directory, 'invocations.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(args[args.indexOf('resume') + 1], 'test-session');
  assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  const codingPrompt = JSON.parse(readFileSync(join(directory, 'prompts.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.match(codingPrompt, /Bridge agent mode: coding/);
  assert.ok(codingPrompt.endsWith('Continue the older conversation'));
  const offline = await send('Offline mirror example', originalId);
  assert.equal(offline.status, 200);
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    data = readHistory(join(directory, '.bridge'));
    if (data.conversations[0].messages.filter(m => m.role === 'assistant' && m.source === 'dashboard' && m.delivery === 'sent').length === 2) break;
  }
  assert.ok(data.conversations[0].messages.some(m => m.text === 'Offline mirror example' && m.delivery === 'failed'));
  assert.equal(data.conversations[0].messages.filter(m => m.role === 'assistant' && m.source === 'dashboard' && m.delivery === 'sent').length, 2);
  await send('/model default', originalId);
  assert.equal(readHistory(join(directory, '.bridge')).conversations[0].model, null);
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGINT');
  await closed;
  assert.throws(() => readFileSync(join(directory, '.bridge/bridge.lock')), { code: 'ENOENT' });
});
