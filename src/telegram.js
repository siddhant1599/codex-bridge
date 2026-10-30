import { chunks } from './core.js';
import { setTimeout as sleep } from 'node:timers/promises';

export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async call(method, body = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(40000),
        });
      } catch { throw new Error(`Telegram ${method}: network request failed.`); }
      let data;
      try { data = await response.json(); } catch { throw new Error(`Telegram ${method}: invalid response.`); }
      if (data.ok) return data.result;
      if (data.error_code === 429 && attempt < 3) {
        await sleep(Math.min(data.parameters?.retry_after || 2, 60) * 1000);
        continue;
      }
      const error = new Error(`Telegram ${method} failed (${data.error_code || response.status}).`);
      error.code = data.error_code;
      throw error;
    }
  }
  async send(chatId, text) {
    for (const part of chunks(text)) {
      await this.call('sendMessage', { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
    }
  }
}
