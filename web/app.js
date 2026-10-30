const $ = id => document.getElementById(id);
const emptyContent = $('messages').firstElementChild.cloneNode(true);
let snapshot = { conversations: [] };
let selected = null;
let lastMessageSignature = '';
let lastListSignature = '';
let submitting = false;
let online = false;
const labels = { idle: 'Ready', working: 'Working', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', stopped: 'Stopped' };
const date = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const time = value => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
      button.onclick = () => { selected = c.id; lastMessageSignature = ''; render(); };
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
    article.append(el('div', 'avatar', message.role === 'user' ? 'Y' : message.role === 'assistant' ? '↗' : '·'));
    const content = el('div');
    const heading = el('div', 'message-heading', message.role === 'user' ? `You · ${message.source === 'dashboard' ? 'Dashboard' : 'Telegram'}` : message.role === 'assistant' ? 'Codex' : 'Bridge');
    const timestamp = el('time', '', `${date(message.at)} · ${time(message.at)}`);
    timestamp.dateTime = message.at;
    heading.append(timestamp);
    content.append(heading, el('div', 'message-body', message.text));
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
  $('prompt').disabled = !canSend || submitting;
  $('send').disabled = !canSend || submitting || runtime.working || !$('prompt').value.trim();
  $('new-chat').disabled = !canSend || submitting || runtime.working;
  $('stop').hidden = !runtime.working;
  $('stop').disabled = !canSend || submitting || selected !== snapshot.currentId;
  $('composer-hint').textContent = !online ? 'Bridge disconnected. Start npm start to reconnect.' : !runtime.canSend ? 'Archive mode. Run npm start to chat here.' : runtime.working ? 'Codex is working. You can draft your next message.' : 'Enter to send · Shift+Enter for a new line';
}

async function submitMessage(text, clearDraft = false) {
  if (submitting || !selected) return;
  submitting = true;
  $('send-error').hidden = true;
  updateComposer();
  try {
    const response = await fetch('/api/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Request': '1' },
      body: JSON.stringify({ text, conversationId: selected }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Message could not be sent.');
    selected = result.conversationId;
    lastMessageSignature = '';
    if (clearDraft) $('prompt').value = '';
    await refresh(false);
  } catch (error) {
    $('send-error').textContent = error instanceof TypeError || error.name === 'TimeoutError' ? 'Connection interrupted. Check conversation history before retrying; your message may already have been accepted.' : error.message;
    $('send-error').hidden = false;
  } finally { submitting = false; updateComposer(); if (!$('prompt').disabled) $('prompt').focus(); }
}
$('prompt').addEventListener('input', updateComposer);
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('send').disabled) $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', event => { event.preventDefault(); if (!$('send').disabled) submitMessage($('prompt').value.trim(), true); });
$('new-chat').addEventListener('click', () => submitMessage('/new'));
$('stop').addEventListener('click', () => submitMessage('/stop'));

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
