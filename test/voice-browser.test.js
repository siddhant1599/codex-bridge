import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function browser({ microphone, fetcher } = {}) {
  const handlers = new Map();
  function element() {
    return { hidden: false, disabled: false, textContent: '', setAttribute() {}, addEventListener(event, handler) { this[event] = handler; } };
  }
  const recordings = [];
  const tracks = [];
  const texts = [];
  const errors = [];
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/mp4'; }
    constructor(stream, { mimeType }) { this.mimeType = mimeType; this.state = 'inactive'; this.listeners = {}; recordings.push(this); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.listeners.dataavailable({ data: new Blob(['recorded audio']) }); this.listeners.stop(); });
    }
  }
  const getUserMedia = microphone || (async () => {
    const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track);
    return { getTracks: () => [track] };
  });
  const context = vm.createContext({ window: { isSecureContext: true, MediaRecorder: Recorder, addEventListener(event, handler) { handlers.set(event, handler); } },
    navigator: { mediaDevices: { getUserMedia } }, MediaRecorder: Recorder, Blob, AbortController, AbortSignal,
    setInterval, clearInterval, Date, Error, TypeError, fetch: fetcher || (async () => ({ ok: true, json: async () => ({ text: 'Explain my code' }) })),
  });
  vm.runInContext(readFileSync(new URL('../web/voice.js', import.meta.url), 'utf8'), context);
  const button = element(); const cancelButton = element(); const status = element();
  let voice;
  const settings = { enabled: true, maxSeconds: 120, maxBytes: 1000 };
  voice = new context.window.BridgeVoiceInput({ button, cancelButton, status, onText: text => texts.push(text), onError: error => errors.push(error), onState: () => voice.update(settings, true) });
  voice.update(settings, true);
  return { voice, button, status, tracks, recordings, texts, errors, handlers };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('browser records a supported format, releases the microphone and returns an unsent transcript', async t => {
  const requests = [];
  const b = browser({ fetcher: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ text: 'Explain my code' }) };
  } });
  t.after(() => b.voice.cancel());
  await b.voice.start();
  assert.equal(b.voice.active, true);
  assert.equal(b.button.textContent, 'Finish recording');
  b.voice.finish();
  await settle();
  assert.equal(b.tracks[0].stopped, true);
  assert.equal(b.voice.active, false);
  assert.deepEqual(b.texts, ['Explain my code']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/transcribe');
  assert.equal(requests[0].options.headers['Content-Type'], 'audio/mp4');
  assert.deepEqual(b.errors, []);
});

test('browser cancellation releases late permission grants and never uploads discarded recordings', async () => {
  let grant;
  const track = { stopped: false, stop() { this.stopped = true; } };
  const b = browser({ microphone: () => new Promise(resolve => { grant = resolve; }), fetcher: () => assert.fail('Cancelled recording must not upload') });
  const pending = b.voice.start();
  b.voice.cancel();
  grant({ getTracks: () => [track] });
  await pending;
  assert.equal(track.stopped, true);
  assert.equal(b.voice.active, false);
  const c = browser({ fetcher: () => assert.fail('Cancelled recording must not upload') });
  await c.voice.start();
  c.handlers.get('pagehide')();
  await settle();
  assert.equal(c.tracks[0].stopped, true);
  assert.deepEqual(c.texts, []);
});

test('browser handles denied permissions and aborts transcription without inserting late results', async () => {
  const denied = browser({ microphone: async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } });
  await denied.voice.start();
  assert.match(denied.errors[0], /Microphone access was denied/);
  assert.equal(denied.voice.active, false);
  let resolveRequest;
  let signal;
  const b = browser({ fetcher: async (url, options) => {
    signal = options.signal;
    return new Promise(resolve => { resolveRequest = resolve; });
  } });
  await b.voice.start(); b.voice.finish(); await settle();
  b.voice.cancel();
  assert.equal(signal.aborted, true);
  resolveRequest({ ok: true, json: async () => ({ text: 'Discard this' }) });
  await settle();
  assert.deepEqual(b.texts, []);
});
