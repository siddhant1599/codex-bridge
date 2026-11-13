import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { VoiceTranscriber, voiceConfig, MAX_AUDIO_BYTES, runAudioProcess } from '../src/voice.js';
import { Telegram } from '../src/telegram.js';
import { dashboardHandler } from '../src/dashboard.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-voice-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cfg = { ...voiceConfig({}), bin: process.execPath, ffmpeg: process.execPath, directory: join(directory, 'temp'), modelDirectory: join(directory, 'models') };
  mkdirSync(cfg.modelDirectory);
  writeFileSync(join(cfg.modelDirectory, 'base.pt'), 'fake model');
  return { directory, cfg };
}

function fakeAudio({ silent = false, long = false, text = 'Inspect the project' } = {}) {
  return async (bin, args, { cwd, signal }) => {
    signal.throwIfAborted();
    if (args.includes('-f')) {
      const pcm = Buffer.alloc(long ? 121 * 32000 : 3200);
      if (!silent) pcm.writeInt16LE(1000);
      writeFileSync(args.at(-1), pcm);
    } else {
      assert.equal(args[args.indexOf('--task') + 1], 'transcribe');
      assert.equal(args[args.indexOf('--model') + 1].endsWith('base.pt'), true);
      writeFileSync(join(cwd, 'speech.json'), JSON.stringify({ text }));
    }
  };
}

test('local transcription returns text and removes audio after success, silence, duration errors and empty transcripts', async t => {
  const { cfg } = fixture(t);
  for (const [options, expected] of [[{}, 'Inspect the project'], [{ silent: true }, /No speech/], [{ long: true }, /two minutes/], [{ text: '' }, /No speech/]]) {
    const voice = new VoiceTranscriber(cfg, fakeAudio(options));
    const result = voice.transcribe(Buffer.from('audio'), 'audio/webm;codecs=opus');
    if (typeof expected === 'string') assert.equal(await result, expected);
    else await assert.rejects(result, expected);
    assert.deepEqual(readdirSync(cfg.directory), []);
    assert.equal(voice.busy, false);
  }
});

test('voice validates setup, type and size without spawning a process', async t => {
  const { cfg } = fixture(t);
  const voice = new VoiceTranscriber(cfg, () => { throw new Error('Must not spawn'); });
  await assert.rejects(voice.transcribe(Buffer.from('x'), 'text/html'), { status: 415 });
  await assert.rejects(voice.transcribe(Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/ogg'), { status: 413 });
  await assert.rejects(voice.transcribe(Buffer.alloc(0), 'audio/ogg'), { status: 400 });
  cfg.provider = 'off';
  await assert.rejects(voice.transcribe(Buffer.from('x'), 'audio/ogg'), /disabled/);
  assert.equal(voice.busy, false);
});

test('cancellation holds the single transcription slot until cleanup and terminates real subprocesses', async t => {
  const { cfg, directory } = fixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const voice = new VoiceTranscriber(cfg, async (bin, args, { signal }) => {
    started();
    await runAudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal, cwd: directory, label: 'test' });
  });
  const controller = new AbortController();
  const pending = voice.transcribe(Buffer.from('recording'), 'audio/ogg', { signal: controller.signal });
  await ready;
  await assert.rejects(voice.transcribe(Buffer.from('another'), 'audio/ogg'), { status: 409 });
  controller.abort();
  await assert.rejects(pending, { status: 499 });
  assert.equal(voice.busy, false);
  assert.deepEqual(readdirSync(cfg.directory), []);
});

test('Telegram downloads enforce metadata and streamed size limits, reject invalid paths and hide credential URLs', async () => {
  const calls = [];
  const telegram = new Telegram('999:private', async url => {
    calls.push(url);
    if (url.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'voice/file.oga' } }) };
    return new Response(Buffer.from('voice bytes'));
  });
  assert.equal((await telegram.downloadVoice({ file_id: 'id' })).toString(), 'voice bytes');
  assert.equal(calls.length, 2);
  await assert.rejects(telegram.downloadVoice({ file_id: 'id', file_size: MAX_AUDIO_BYTES + 1 }), { status: 413 });
  assert.equal(calls.length, 2);
  telegram.fetcher = async url => url.endsWith('/getFile')
    ? { json: async () => ({ ok: true, result: { file_path: '../bad' } }) }
    : assert.fail('Unsafe path must not be fetched');
  await assert.rejects(telegram.downloadVoice({ file_id: 'id' }), /invalid voice file/);
  telegram.fetcher = async url => {
    if (url.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'voice/a.ogg' } }) };
    throw new Error(url);
  };
  await assert.rejects(telegram.downloadVoice({ file_id: 'id' }), error => !error.message.includes('private') && /download/.test(error.message));
  telegram.fetcher = async url => url.endsWith('/getFile')
    ? { json: async () => ({ ok: true, result: { file_path: 'voice/a.ogg' } }) }
    : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } }));
  await assert.rejects(telegram.downloadVoice({ file_id: 'id' }), { status: 413 });
});

test('dashboard audio endpoint protects origins, bounds uploads and produces a draft without submitting a task', async t => {
  const { directory } = fixture(t);
  const transcripts = [];
  const handler = dashboardHandler({ directory, port: 8787, submit: () => assert.fail('Transcription must not submit work'), transcribe: async (audio, type) => {
    transcripts.push({ audio: audio.toString(), type }); return 'Review this draft';
  } });
  async function request(body, headers = {}, target = handler) {
    const req = Readable.from([body]);
    Object.assign(req, { url: '/api/transcribe', method: 'POST', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'x-bridge-request': '1', 'content-type': 'audio/webm;codecs=opus', ...headers } });
    const res = { status: 200, setHeader() {}, writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; } };
    await target(req, res); return res;
  }
  assert.equal(JSON.parse((await request(Buffer.from('audio'))).body).text, 'Review this draft');
  assert.equal((await request(Buffer.from('x'), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(Buffer.from('x'), { 'x-bridge-request': '' })).status, 403);
  assert.equal((await request(Buffer.from('x'), { 'content-type': 'text/html' })).status, 415);
  assert.equal((await request(Buffer.from('x'), { 'content-length': String(MAX_AUDIO_BYTES + 1) })).status, 413);
  assert.equal((await request(Buffer.alloc(MAX_AUDIO_BYTES + 1))).status, 413);
  assert.equal((await request(Buffer.alloc(0))).status, 400);
  assert.equal((await request(Buffer.from('x'), {}, dashboardHandler({ directory, port: 8787 }))).status, 503);
  assert.equal(transcripts.length, 1);
});

test('disconnecting a dashboard transcription aborts the local job', async t => {
  const { directory } = fixture(t);
  const res = new EventEmitter();
  Object.assign(res, { setHeader() {}, writeHead() { return this; }, end() { assert.fail('Disconnected response must not be written'); } });
  const handler = dashboardHandler({ directory, port: 8787, transcribe: async (audio, type, { signal }) => {
    res.emit('close');
    assert.equal(signal.aborted, true);
    throw signal.reason;
  } });
  const req = Readable.from([Buffer.from('recording')]);
  Object.assign(req, { url: '/api/transcribe', method: 'POST', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'x-bridge-request': '1', 'content-type': 'audio/ogg' } });
  await handler(req, res);
});
