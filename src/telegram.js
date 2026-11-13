import { chunks } from './core.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { MAX_AUDIO_BYTES, voiceError } from './voice.js';

export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async call(method, body = {}, { signal } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
        });
      } catch { throw new Error(`Telegram ${method}: network request failed.`); }
      let data;
      try { data = await response.json(); } catch { throw new Error(`Telegram ${method}: invalid response.`); }
      if (data.ok) return data.result;
      if (data.error_code === 429 && attempt < 3) {
        await sleep(Math.min(data.parameters?.retry_after || 2, 60) * 1000, undefined, { signal });
        continue;
      }
      const error = new Error(`Telegram ${method} failed (${data.error_code || response.status}).`);
      error.code = data.error_code;
      throw error;
    }
  }
  async downloadVoice(voice, { signal } = {}) {
    if (voice.file_size > MAX_AUDIO_BYTES) throw voiceError(413, 'Voice recordings must be smaller than 10 MB.');
    const file = await this.call('getFile', { file_id: voice.file_id }, { signal });
    if (file.file_size > MAX_AUDIO_BYTES) throw voiceError(413, 'Voice recordings must be smaller than 10 MB.');
    if (typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.startsWith('/') || file.file_path.split('/').includes('..')) {
      throw voiceError(502, 'Telegram returned an invalid voice file.');
    }
    let response;
    try {
      response = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
      });
      if (!response.ok) throw new Error();
    } catch { throw voiceError(502, 'Could not download the Telegram voice note. Please resend it.'); }
    if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
      await response.body?.cancel();
      throw voiceError(413, 'Voice recordings must be smaller than 10 MB.');
    }
    const parts = [];
    let size = 0;
    try {
      for await (const part of response.body) {
        size += part.length;
        if (size > MAX_AUDIO_BYTES) throw voiceError(413, 'Voice recordings must be smaller than 10 MB.');
        parts.push(Buffer.from(part));
      }
    } catch (error) {
      if (error.status) throw error;
      throw voiceError(502, 'Telegram voice download was interrupted. Please resend it.');
    }
    if (!size) throw voiceError(422, 'The Telegram voice note is empty. Please record it again.');
    return Buffer.concat(parts);
  }
  async send(chatId, text) {
    for (const part of chunks(text)) {
      await this.call('sendMessage', { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
    }
  }
}
