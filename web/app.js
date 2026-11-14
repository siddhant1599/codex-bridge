const $ = id => document.getElementById(id);
const themeMedia = matchMedia('(prefers-color-scheme: dark)');
const savedTheme = localStorage.getItem('bridge-theme');
$('theme').value = ['light', 'dark', 'system'].includes(savedTheme) ? savedTheme : 'system';
function applyTheme() {
  const dark = $('theme').value === 'dark' || ($('theme').value === 'system' && themeMedia.matches);
  document.documentElement.classList.toggle('dark', dark);
}
$('theme').addEventListener('change', () => { localStorage.setItem('bridge-theme', $('theme').value); applyTheme(); });
themeMedia.addEventListener('change', applyTheme);
applyTheme();
const emptyContent = $('messages').firstElementChild.cloneNode(true);
let snapshot = { conversations: [] };
let selected = null;
let lastMessageSignature = '';
let lastListSignature = '';
let submitting = false;
let online = false;
let draftInput = 'text';
const labels = { idle: 'Ready', working: 'Working', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', stopped: 'Stopped' };
const date = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const time = value => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatMessage(text) {
  const body = el('div', 'message-body');
  const parts = String(text).split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```')) {
      const lines = part.slice(3, -3).split('\n');
      const pre = el('pre', 'message-code');
      const code = el('code', '', lines.slice(1).join('\n').replace(/\n$/, ''));
      pre.append(code); body.append(pre);
    } else {
      const block = el('div', 'message-text');
      const tokens = part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
      for (const token of tokens) {
        if (token.startsWith('**') && token.endsWith('**')) block.append(el('strong', '', token.slice(2, -2)));
        else if (token.startsWith('`') && token.endsWith('`')) block.append(el('code', 'inline-code', token.slice(1, -1)));
        else block.append(document.createTextNode(token));
      }
      body.append(block);
    }
  }
  return body;
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const all = [...snapshot.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const filtered = all.filter(c => `${c.title} ${c.messages.map(m => m.text).join(' ')}`.toLowerCase().includes(query));
  if (!selected || !all.some(c => c.id === selected)) selected = snapshot.currentId || all[0]?.id;
  $('count').textContent = all.length;
  const listSignature = JSON.stringify([selected, query, all.map(c => [c.id, c.title, c.updatedAt, c.status, c.messages.length])]);
  if (lastListSignature !== listSignature) {
    lastListSignature = listSignature;
    $('conversations').replaceChildren();
    for (const c of filtered) {
      const button = el('button', `conversation${c.id === selected ? ' selected' : ''}`);
      button.setAttribute('aria-current', c.id === selected ? 'true' : 'false');
      button.append(el('span', 'conversation-title', c.title));
      button.append(el('span', 'conversation-preview', c.messages.at(-1)?.text || 'Waiting for your first message'));
      const info = el('span', 'conversation-info');
      info.append(el('span', '', date(c.updatedAt)), el('b', '', labels[c.status] || c.status));
      button.append(info);
      button.onclick = () => { if (selected !== c.id) voice.cancel(); selected = c.id; lastMessageSignature = ''; render(); };
      $('conversations').append(button);
    }
    if (!filtered.length) $('conversations').append(el('p', 'no-results', query ? 'No conversations match your search.' : 'Your conversations will appear here.'));
  }
  const runtime = snapshot.runtime || {};
  updateComposer();
  $('connection').textContent = runtime.connected ? runtime.telegramConnected ? 'Bridge connected' : 'Telegram reconnecting' : 'Archive viewer';
  $('connection').className = `connection${runtime.connected && runtime.telegramConnected ? ' live' : ''}`;
  $('project').textContent = runtime.project || 'Local conversation archive';
  const c = all.find(item => item.id === selected);
  $('export').disabled = !c || !c.messages.length;
  if (!c) return;
  $('title').textContent = c.title === 'New conversation' ? 'Your next conversation starts here.' : c.title;
  $('status').textContent = labels[c.status] || c.status;
  $('status').dataset.status = c.status;
  $('meta').textContent = `${c.messages.filter(m => m.role !== 'system').length} messages · ${date(c.createdAt)} · Model: ${c.model || runtime.defaultModel || 'Codex/session default'} · Agent: ${c.agentMode || 'auto'}`;
  $('session').hidden = !c.thread;
  $('session').textContent = `Session ${c.thread || ''}`;
  $('project').textContent = c.project || runtime.project || 'Local conversation archive';
  const signature = JSON.stringify([c.id, c.messages, c.status]);
  if (lastMessageSignature === signature) return;
  const isNewSelection = !lastMessageSignature;
  lastMessageSignature = signature;
  const panel = $('messages');
  const follow = isNewSelection || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
  const scroll = panel.scrollTop;
  if (!c.messages.length) { panel.replaceChildren(emptyContent.cloneNode(true)); return; }
  panel.replaceChildren();
  for (const message of c.messages) {
    const article = el('article', `message ${message.role}`);
    const avatar = el('div', 'avatar', message.role === 'user' ? 'Y' : message.role === 'assistant' ? undefined : '·');
    if (message.role === 'assistant') {
      const logo = el('img', 'avatar-logo');
      logo.src = '/bridge-logo.webp';
      logo.alt = '';
      avatar.append(logo);
    }
    article.append(avatar);
    const content = el('div');
    const heading = el('div', 'message-heading', message.role === 'user' ? `You · ${message.source === 'dashboard' ? 'Dashboard' : 'Telegram'}` : message.role === 'assistant' ? 'Codex' : 'Bridge');
    if (message.input === 'voice') heading.append(el('span', 'voice-label', 'Voice'));
    const timestamp = el('time', '', `${date(message.at)} · ${time(message.at)}`);
    timestamp.dateTime = message.at;
    heading.append(timestamp);
    content.append(heading, formatMessage(message.text));
    if (message.delivery === 'failed') content.append(el('div', 'delivery-error', 'Saved here · delivery to Telegram failed'));
    article.append(content);
    panel.append(article);
  }
  if (c.status === 'working') panel.append(el('div', 'working-note', 'Codex is working. Its reply will appear here when ready.'));
  panel.scrollTop = follow ? panel.scrollHeight : scroll;
}

$('search').addEventListener('input', render);
$('export').addEventListener('click', () => {
  const c = snapshot.conversations.find(item => item.id === selected);
  if (!c) return;
  const text = `${c.title}\n${c.project}\nSession: ${c.thread || 'Not started'}\n\n${c.messages.map(m => `[${m.at}] ${m.role}\n${m.text}`).join('\n\n')}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = el('a'); link.href = url; link.download = `codex-conversation-${c.id}.txt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function updateComposer() {
  const runtime = snapshot.runtime || {};
  const canSend = online && runtime.canSend && selected;
  $('attachments').disabled = !canSend || submitting || voice.active;
  $('prompt').disabled = !canSend || submitting || voice.active;
  $('send').disabled = !canSend || submitting || voice.active || runtime.working || (!$('prompt').value.trim() && !$('attachments').files.length) || $('prompt').value.length > 8000;
  $('new-chat-sidebar').disabled = !canSend || submitting || voice.active || runtime.working;
  $('mode').disabled = !canSend || submitting || runtime.working;
  $('model').disabled = !canSend || submitting || runtime.working;
  const current = snapshot.conversations.find(item => item.id === selected);
  $('mode').textContent = `${current?.agentMode || 'Auto'} ▾`;
  const models = runtime.models || [];
  const selectedModel = current?.model || runtime.defaultModel || '';
  if ($('model').dataset.signature !== JSON.stringify(models.map(item => item.id))) {
    $('model').replaceChildren(new Option('Default model', 'default'), ...models.map(item => new Option(item.name, item.id)));
    $('model').dataset.signature = JSON.stringify(models.map(item => item.id));
  }
  $('model').value = models.some(item => item.id === selectedModel) ? selectedModel : 'default';
  $('attachment-list').replaceChildren(...[...$('attachments').files].map((file, index) => {
    const chip = el('span', 'file-chip');
    chip.append(el('span', 'file-name', file.name));
    const remove = el('button', 'file-remove', '×');
    remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.disabled = !canSend || submitting;
    remove.onclick = () => { const files = new DataTransfer(); [...$('attachments').files].forEach((item, i) => { if (i !== index) files.items.add(item); }); $('attachments').files = files.files; updateComposer(); };
    chip.append(remove); return chip;
  }));
  $('send').textContent = '↑';
  $('stop').hidden = !runtime.working;
  $('stop').disabled = !canSend || submitting || selected !== snapshot.currentId;
  $('composer-hint').textContent = !online ? 'Bridge disconnected. Start npm start to reconnect.' : !runtime.canSend ? 'Archive mode. Run npm start to chat here.' : runtime.working ? 'Codex is working. You can draft your next message.' : '';
  voice.update(runtime.voice, canSend && !submitting);
}

async function submitMessage(text, clearDraft = false) {
  if (submitting || !selected) return;
  submitting = true;
  $('send-error').hidden = true;
  updateComposer();
  try {
    const files = clearDraft ? [...$('attachments').files] : [];
    if (files.length > 3 || files.some(file => file.size > 10 * 1024 * 1024)) throw new Error('Choose up to three files, each under 10 MB.');
    const attachments = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, data: reader.result.split(',')[1] });
      reader.onerror = () => reject(new Error('Could not read attachment.'));
      reader.readAsDataURL(file);
    })));
    const response = await fetch('/api/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Request': '1', 'X-Bridge-Attachments': '1' },
      body: JSON.stringify({ text, attachments, conversationId: selected, input: clearDraft ? draftInput : 'text' }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Message could not be sent.');
    selected = result.conversationId;
    lastMessageSignature = '';
    if (clearDraft) { $('attachments').value = ''; $('prompt').value = ''; draftInput = 'text'; }
    await refresh(false);
  } catch (error) {
    $('send-error').textContent = error instanceof TypeError || error.name === 'TimeoutError' ? 'Connection interrupted. Check conversation history before retrying; your message may already have been accepted.' : error.message;
    $('send-error').hidden = false;
  } finally { submitting = false; updateComposer(); if (!$('prompt').disabled) $('prompt').focus(); }
}
$('attachments').addEventListener('change', updateComposer);
$('prompt').addEventListener('input', updateComposer);
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('send').disabled) $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', event => { event.preventDefault(); if (!$('send').disabled) submitMessage($('prompt').value.trim(), true); });
$('new-chat-sidebar').addEventListener('click', () => submitMessage('/new'));
$('mode').addEventListener('click', () => { const c=snapshot.conversations.find(item=>item.id===selected); const mode=({auto:'coding',coding:'off',off:'auto'})[c?.agentMode||'auto']; submitMessage(`/agent ${mode}`); });
$('model').addEventListener('change', () => submitMessage(`/model ${$('model').value}`));
$('messages').addEventListener('click', event => { const button = event.target.closest('[data-prompt]'); if (!button || $('prompt').disabled) return; $('prompt').value = button.dataset.prompt; updateComposer(); $('prompt').focus(); });
$('stop').addEventListener('click', () => submitMessage('/stop'));

const voice = new window.BridgeVoiceInput({
  button: $('record-voice'), cancelButton: $('cancel-voice'), status: $('voice-status'),
  onState: updateComposer,
  onError: text => { $('send-error').textContent = text; $('send-error').hidden = false; },
  onText: text => {
    const combined = [$('prompt').value.trim(), text].filter(Boolean).join('\n');
    $('prompt').value = combined;
    draftInput = 'voice';
    $('send-error').hidden = combined.length <= 8000;
    if (combined.length > 8000) $('send-error').textContent = 'Your draft exceeds 8,000 characters. Shorten it before sending.';
    updateComposer();
    $('prompt').focus();
  },
});

async function refresh(schedule = true) {
  try {
    const response = await fetch('/api/history', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('History unavailable');
    snapshot = await response.json();
    online = true;
    $('error').hidden = true;
    render();
  } catch {
    online = false;
    updateComposer();
    $('connection').textContent = 'Disconnected'; $('connection').className = 'connection';
    $('error').textContent = 'The dashboard cannot reach the bridge. Your last loaded history is still visible. Start npm start to reconnect.';
    $('error').hidden = false;
  } finally { if (schedule) setTimeout(refresh, 2000); }
}
refresh();
