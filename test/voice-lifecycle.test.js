import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readHistory } from '../src/history.js';

test('Telegram voice is authorized before download, mirrored once, and cancellable without starting Codex', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-voice-flow-'));
  const modelDirectory = join(directory, 'models');
  mkdirSync(modelDirectory);
  writeFileSync(join(modelDirectory, 'base.pt'), 'model');
  function executable(name, source) {
    const path = join(directory, name);
    writeFileSync(path, '#!/usr/bin/env node\n' + source); chmodSync(path, 0o700); return path;
  }
  const codex = executable('codex.cjs', `
if (process.argv.includes('--version') || process.argv.includes('status')) process.exit(0);
if (process.argv.includes('debug')) process.exit(1);
let prompt = ''; process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
 require('node:fs').appendFileSync('tasks.jsonl', JSON.stringify(prompt) + '\\n');
 console.log(JSON.stringify({type:'thread.started',thread_id:'voice-session'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Voice task complete'}}));
});`);
  const ffmpeg = executable('ffmpeg.cjs', `
const fs = require('node:fs');
const input = process.argv[process.argv.indexOf('-i') + 1];
const slow = fs.readFileSync(input, 'utf8') === 'slow';
fs.writeFileSync(require('node:path').join(${JSON.stringify(directory)}, slow ? 'slow-started' : 'fast-started'), 'started');
setTimeout(() => { const pcm = Buffer.alloc(3200); pcm.writeInt16LE(500); fs.writeFileSync(process.argv.at(-1), pcm); }, slow ? 10000 : 50);`);
  const whisper = executable('whisper.cjs', `require('node:fs').writeFileSync('speech.json', JSON.stringify({text:'Explain the voice feature'}));`);
  const preload = join(directory, 'preload.mjs');
  writeFileSync(preload, `
import { Server } from 'node:http';
import { appendFileSync } from 'node:fs';
const updates=[]; let sequence=0;
Server.prototype.listen = function(port,host,ready) { this.address=()=>({port:8787}); queueMicrotask(ready); return this; };
process.on('message', message => { updates.push({update_id:++sequence,message}); });
globalThis.fetch = async (url,options) => {
 const method=url.split('/').at(-1);
 if(url.includes('/file/bot')) return new Response(Buffer.from(method==='slow.ogg'?'slow':'fast'));
 let result={};
 if(method==='getMe') result={id:999,username:'fake_bot'};
 if(method==='getUpdates') { await new Promise(resolve=>setTimeout(resolve,20)); result=updates.splice(0); }
 if(method==='getFile') {
   const body=JSON.parse(options.body);
   appendFileSync('downloads.jsonl',JSON.stringify(body)+'\\n');
   result={file_path:'voice/'+body.file_id+'.ogg'};
 }
 if(method==='sendMessage') appendFileSync('sent.jsonl',JSON.stringify(JSON.parse(options.body))+'\\n');
 return {json:async()=>({ok:true,result})};
};`);
  const child = spawn(process.execPath, ['--import', preload, resolve('src/main.js')], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '999:fake', TELEGRAM_ALLOWED_USER_ID: '123', CODEX_BIN: codex, CODEX_WORKDIR: directory,
      CODEX_SANDBOX: 'read-only', VOICE_PROVIDER: 'local', VOICE_MODEL: 'base', VOICE_MODEL_DIR: modelDirectory, WHISPER_BIN: whisper, FFMPEG_BIN: ffmpeg },
  });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); } rmSync(directory, { recursive: true, force: true }); });
  let logs=''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  async function until(condition) { for(let i=0;i<200;i++) { if(condition()) return; await sleep(25); } assert.fail(logs); }
  const history = () => readHistory(join(directory, '.bridge')).conversations[0];
  const send = (body, id = 123) => child.send({ from: {id}, chat: {id,type:'private'}, ...body });
  const lines = file => existsSync(join(directory,file)) ? readFileSync(join(directory,file),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  await until(() => logs.includes('Listening as'));
  send({ voice: { file_id:'unauthorized',duration:1 } }, 456);
  send({ voice: { file_id:'long',duration:121 } });
  send({ voice: { file_id:'fast',duration:2,mime_type:'audio/ogg' } });
  await until(() => history()?.messages.some(m => m.text==='Voice task complete' && m.delivery==='sent'));
  assert.deepEqual(lines('downloads.jsonl'), [{file_id:'fast'}]);
  assert.equal(lines('tasks.jsonl').length, 1);
  assert.match(lines('tasks.jsonl')[0], /Explain the voice feature$/);
  const message = history().messages.find(m => m.role==='user' && m.text==='Explain the voice feature');
  assert.equal(message.input, 'voice');
  assert.equal(message.source, 'telegram');
  const sent = lines('sent.jsonl').map(m=>m.text);
  assert.equal(sent.filter(text=>text.includes('Voice transcript')).length, 1);
  assert.ok(sent.findIndex(text=>text.includes('Voice transcript')) < sent.indexOf('Voice task complete'));
  await sleep(50);
  send({ voice: { file_id:'slow',duration:2,mime_type:'audio/ogg' } });
  await until(() => existsSync(join(directory,'slow-started')));
  send({ text:'/status' });
  send({ text:'/stop' });
  await until(() => history()?.messages.some(m => m.text==='Voice message cancelled. Nothing was sent to Codex.'));
  await until(() => !JSON.parse(readFileSync(join(directory,'.bridge/state.json'),'utf8')).active);
  assert.equal(lines('tasks.jsonl').length, 1, 'Cancelled audio must never reach Codex');
  assert.equal(history().status, 'stopped');
  assert.ok(history().messages.some(m=>m.text.includes('State: working')));
  assert.deepEqual(readdirSync(join(directory,'.bridge/voice-tmp')), []);
  child.kill('SIGINT');
  await new Promise(resolve => child.once('close',resolve));
  assert.equal(existsSync(join(directory,'.bridge/bridge.lock')), false);
});
