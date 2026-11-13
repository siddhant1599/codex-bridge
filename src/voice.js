import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { resolve, join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 120;
const formats = new Map([
  ['audio/ogg', 'ogg'], ['audio/webm', 'webm'], ['video/webm', 'webm'],
  ['audio/mp4', 'm4a'], ['audio/mpeg', 'mp3'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav'],
]);
export const voiceError = (status, message) => Object.assign(new Error(message), { status });

export function audioExtension(type = '') {
  const extension = formats.get(type.split(';')[0].trim().toLowerCase());
  if (!extension) throw voiceError(415, 'Unsupported audio format. Record a voice note using the microphone.');
  return extension;
}

export function voiceConfig(env = process.env) {
  const provider = env.VOICE_PROVIDER || 'local';
  if (!['local', 'off'].includes(provider)) throw new Error('VOICE_PROVIDER must be local or off.');
  const model = env.VOICE_MODEL || 'base';
  if (!/^(tiny|base|small)(\.en)?$/.test(model)) throw new Error('VOICE_MODEL must be tiny, base, small, or their .en variants.');
  const language = env.VOICE_LANGUAGE?.trim() || '';
  if (language && !/^[a-z]{2,3}$/.test(language)) throw new Error('VOICE_LANGUAGE must be a language code such as en, or empty for automatic detection.');
  return { provider, model, language, bin: env.WHISPER_BIN || 'whisper', ffmpeg: env.FFMPEG_BIN || 'ffmpeg',
    modelDirectory: resolve(env.VOICE_MODEL_DIR || '.bridge/voice-models'), directory: resolve('.bridge/voice-tmp'), timeout: 300_000 };
}

function executable(bin) {
  return (bin.includes('/') ? [resolve(bin)] : (process.env.PATH || '').split(delimiter).map(dir => join(dir, bin)))
    .some(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

export function voiceStatus(cfg) {
  let reason = '';
  if (cfg.provider === 'off') reason = 'Voice input is disabled in .env.';
  else if (!executable(cfg.bin) || !executable(cfg.ffmpeg)) reason = 'Install openai-whisper and ffmpeg, then run npm run voice:setup.';
  else if (!existsSync(join(cfg.modelDirectory, `${cfg.model}.pt`))) reason = 'Run npm run voice:setup in the bridge folder to download the speech model.';
  return { enabled: !reason, reason, maxBytes: MAX_AUDIO_BYTES, maxSeconds: MAX_AUDIO_SECONDS, timeoutMs: cfg.timeout };
}

// Local audio tools receive no bot, GitHub, or API credentials. Arguments never use a shell.
export function runAudioProcess(bin, args, { signal, cwd, label }) {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(bin, args, { cwd, env, stdio: 'ignore', detached: process.platform !== 'win32' });
    let killTimer;
    const kill = sig => {
      try { if (child.pid) { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); } }
      catch (error) { if (error.code !== 'ESRCH') child.kill(sig); }
    };
    const abort = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1000); killTimer.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); reject(voiceError(503, `Could not launch ${label}. Check the voice setup in README.md.`)); });
    child.once('close', code => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) return reject(voiceError(422, `${label} could not process this recording. Check the installation or try a shorter, clearer voice note.`));
      resolvePromise();
    });
    if (signal?.aborted) abort();
  });
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class VoiceTranscriber {
  constructor(cfg = voiceConfig(), run = runAudioProcess) { this.cfg = cfg; this.run = run; this.busy = false; }
  status() { return { ...voiceStatus(this.cfg), busy: this.busy }; }
  stop() { this.controller?.abort(); }
  async transcribe(audio, type, { signal, prepare = false } = {}) {
    const cfg = this.cfg;
    if (this.busy) throw voiceError(409, 'Another voice message is being transcribed. Try again when it finishes.');
    if (!prepare && !this.status().enabled) throw voiceError(503, this.status().reason);
    const extension = audioExtension(type);
    if (!Buffer.isBuffer(audio) || !audio.length) throw voiceError(400, 'The recording is empty. Please try again.');
    if (audio.length > MAX_AUDIO_BYTES) throw voiceError(413, 'Voice recordings must be smaller than 10 MB.');
    this.busy = true;
    this.controller = new AbortController();
    const deadline = AbortSignal.timeout(prepare ? 900_000 : cfg.timeout);
    signal = AbortSignal.any([this.controller.signal, deadline, ...(signal ? [signal] : [])]);
    let directory;
    try {
      signal.throwIfAborted();
      await mkdir(cfg.directory, { recursive: true, mode: 0o700 });
      await mkdir(cfg.modelDirectory, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(cfg.directory, 'recording-'));
      const input = join(directory, `input.${extension}`);
      const pcmFile = join(directory, 'audio.pcm');
      const speechFile = join(directory, 'speech.wav');
      await writeFile(input, audio, { mode: 0o600 });
      await this.run(cfg.ffmpeg, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input,
        '-t', String(MAX_AUDIO_SECONDS + 1), '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', pcmFile], { signal, cwd: directory, label: 'FFmpeg' });
      const pcm = await readFile(pcmFile);
      if (pcm.length > MAX_AUDIO_SECONDS * 32000) throw voiceError(413, 'Keep voice recordings to two minutes or less.');
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      if (!prepare && peak < 16) throw voiceError(422, 'No speech was detected. Check your microphone and try again.');
      await writeFile(speechFile, wav(pcm), { mode: 0o600 });
      const model = prepare ? cfg.model : join(cfg.modelDirectory, `${cfg.model}.pt`);
      const args = [speechFile, '--model', model, '--model_dir', cfg.modelDirectory, '--device', 'cpu', '--fp16', 'False',
        '--output_dir', directory, '--output_format', 'json', '--verbose', 'False', '--task', 'transcribe', '--threads', '4',
        '--condition_on_previous_text', 'False'];
      if (cfg.language || prepare) args.push('--language', cfg.language || 'en');
      await this.run(cfg.bin, args, { signal, cwd: directory, label: 'Whisper' });
      signal.throwIfAborted();
      const output = join(directory, 'speech.json');
      if ((await stat(output)).size > 2 * 1024 * 1024) throw voiceError(422, 'The transcript is too large. Please record a shorter message.');
      const result = JSON.parse(await readFile(output, 'utf8'));
      if (prepare) return '';
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text) throw voiceError(422, 'No speech was detected. Please try a clearer recording.');
      if (text.length > 8000) throw voiceError(413, 'The transcript exceeds 8,000 characters. Please record a shorter message.');
      return text;
    } catch (error) {
      if (deadline.aborted) throw voiceError(504, 'Voice transcription timed out. Try a shorter recording or set VOICE_MODEL=tiny and run npm run voice:setup.');
      if (signal.aborted) throw voiceError(499, 'Voice transcription cancelled.');
      if (error.status) throw error;
      throw voiceError(500, 'Could not read the voice transcript. Run npm run voice:setup and try again.');
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { this.busy = false; this.controller = null; }
    }
  }
  async prepare() { await this.transcribe(wav(Buffer.alloc(32000)), 'audio/wav', { prepare: true }); }
}
