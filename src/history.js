import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

export function readHistory(directory) {
  try { return JSON.parse(readFileSync(resolve(directory, 'history.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, currentId: null, conversations: [] };
  }
}

export class History {
  constructor(directory, { redact = String, log = console.log } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = resolve(directory, 'history.json');
    this.data = readHistory(directory);
    this.redact = redact;
    this.log = log;
    for (const conversation of this.data.conversations) {
      if (conversation.status === 'working') conversation.status = 'interrupted';
    }
    this.save();
  }
  save() {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  select(thread = null, { fresh = false, project = '' } = {}) {
    let conversation = !fresh && this.data.conversations.find(item => thread ? item.thread === thread : item.id === this.data.currentId && !item.thread);
    if (!conversation) {
      const now = new Date().toISOString();
      conversation = { id: randomUUID(), thread, title: 'New conversation', project, status: 'idle', createdAt: now, updatedAt: now, messages: [] };
      this.data.conversations.push(conversation);
    }
    this.data.currentId = conversation.id;
    this.save();
    return conversation.id;
  }
  update(id, fields) {
    Object.assign(this.data.conversations.find(item => item.id === id), fields, { updatedAt: new Date().toISOString() });
    this.save();
  }
  add(id, role, text, source = 'telegram') {
    const conversation = this.data.conversations.find(item => item.id === id);
    const message = { id: randomUUID(), role, text: this.redact(text), source, at: new Date().toISOString() };
    conversation.messages.push(message);
    conversation.updatedAt = message.at;
    if (role === 'user' && !message.text.startsWith('/') && conversation.title === 'New conversation') conversation.title = message.text.replace(/\s+/g, ' ').slice(0, 85);
    this.save();
    const printable = stripVTControlCharacters(message.text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    this.log(`\n[${new Date(message.at).toLocaleTimeString()}] ${role === 'user' ? `You · ${source === 'dashboard' ? 'Dashboard' : 'Telegram'}` : role === 'assistant' ? 'Codex' : 'Bridge'}\n${printable}\n`);
    return message.id;
  }
  delivery(id, messageId, status) {
    this.data.conversations.find(item => item.id === id).messages.find(item => item.id === messageId).delivery = status;
    this.save();
  }
}
