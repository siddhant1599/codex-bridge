import { accessSync, constants, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { authorized, config, lock, Store, listAvailableModels, secretRedactor } from './core.js';
import { agentModes, runBridgeAgent } from '../coding-agent/bridge.js';
import { Telegram } from './telegram.js';
import { History } from './history.js';
import { startDashboard } from './dashboard.js';

const help = 'Send a text message to work with Codex.\n/new — start a fresh conversation\n/resume UUID — continue a saved local CLI session\n/status — show project and session\n/model [name|default] — inspect or change this conversation’s model\n/agent [auto|coding|off] — choose the coding-agent profile\n/stop — cancel current work\n/help — show commands\nOnly one request runs at a time. Send your next message after the reply.';
let activeJob;
let dashboard;

async function main() {
  const cfg = config();
  const telegram = new Telegram(cfg.token);
  const identify = process.argv.includes('--identify');
  if (!identify && !cfg.owner) throw new Error('Set TELEGRAM_ALLOWED_USER_ID. First run npm run identify, then message your bot.');
  if (!identify && !/^\d+$/.test(cfg.owner)) throw new Error('TELEGRAM_ALLOWED_USER_ID is set but must contain digits only, not a Telegram username or phone number. Run npm run identify, message your bot, then copy the printed Telegram user ID into .env.');
  const directory = resolve('.bridge');
  const release = lock(directory);
  let running;
  let shuttingDown = false;
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => {
    shuttingDown = true;
    // Polling can otherwise hold the process (and lock) open for 40 seconds.
    // With no Codex child to stop, exit immediately and run the exit cleanup.
    if (!running) process.exit(0);
    running?.stop();
    setTimeout(() => process.exit(0), 6500).unref();
  });
  const bot = await telegram.call('getMe');
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('This bot has an active webhook. Use a dedicated bot, or remove its webhook before starting this polling bridge.');
  if (identify) {
    console.log(`Open Telegram on your phone and send hello to @${bot.username}. Do not type hello in this terminal. Your numeric user ID will appear here. No messages will be forwarded to Codex. Ctrl+C when done.`);
    let offset = 0;
    while (!shuttingDown) {
      const updates = await telegram.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (message?.chat?.type === 'private') console.log(`Telegram user ID: ${message.from.id}; username: ${message.from.username || '(none)'}`);
      }
    }
    return;
  }
  if (!statSync(cfg.cwd).isDirectory()) throw new Error('CODEX_WORKDIR must be a directory.');
  accessSync(cfg.cwd, constants.R_OK);
  execFileSync(cfg.bin, ['--version'], { stdio: 'pipe' });
  execFileSync(cfg.bin, ['login', 'status'], { stdio: 'pipe' });
  if (process.argv.includes('--check')) { console.log(`Ready: @${bot.username}, owner ${cfg.owner}, project ${cfg.cwd}. Codex authentication is available.`); return; }
  const store = new Store(directory);
  if (store.data.owner && (store.data.owner !== cfg.owner || store.data.bot !== bot.id || store.data.cwd !== cfg.cwd)) {
    throw new Error('Bot, owner, or project changed. Move .bridge/state.json aside to start with fresh state.');
  }
  store.save({ owner: cfg.owner, bot: bot.id, cwd: cfg.cwd });
  const selectedModel = () => history.data.conversations.find(item => item.id === conversation)?.model || cfg.model;
  const modelLabel = () => selectedModel() || 'Codex configuration/session default (no override)';
  const selectedAgent = () => history.data.conversations.find(item => item.id === conversation)?.agentMode || 'auto';
  const redact = secretRedactor();
  let availableModels = [];
  try { availableModels = listAvailableModels(cfg.bin); }
  catch (error) { console.error(`Could not load Codex model list: ${redact(error.message)}`); }
  const history = new History(directory, { redact });
  let conversation = history.select(store.data.thread, { project: cfg.cwd });
  let telegramConnected = true;
  let deliveryQueue = Promise.resolve();
  const deliver = (id, messageId, text) => {
    // Keep dashboard echoes ahead of their replies, even if Codex finishes quickly.
    deliveryQueue = deliveryQueue.then(async () => {
      try { await telegram.send(cfg.owner, redact(text)); history.delivery(id, messageId, 'sent'); }
      catch (error) { history.delivery(id, messageId, 'failed'); console.error(error.message, 'Message retained in conversation history.'); }
    }).catch(error => { console.error('Could not record Telegram delivery:', redact(error.message)); });
    return deliveryQueue;
  };
  const report = async (text, role = 'system', id = conversation, source = 'telegram') => {
    const messageId = history.add(id, role, text, source);
    const delivery = deliver(id, messageId, text);
    // Accept browser requests promptly; Telegram outages must not stall the dashboard.
    if (source !== 'dashboard') await delivery;
  };
  dashboard = await startDashboard({ directory,
    runtime: () => ({ connected: !shuttingDown, canSend: !shuttingDown, telegramConnected, working: Boolean(running), defaultModel: cfg.model, project: cfg.cwd, bot: bot.username }),
    submit: async ({ text, conversationId }) => {
      const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
      if (shuttingDown) fail(503, 'The bridge is shutting down.');
      const target = history.data.conversations.find(item => item.id === conversationId);
      if (!target) fail(404, 'Conversation no longer exists. Refresh the dashboard.');
      if (running && text.trim() !== '/stop' && text.trim() !== '/status') fail(409, 'Codex is still working. Wait for its reply or stop the current request.');
      if (running && target.id !== conversation) fail(409, 'Select the active conversation to stop it or check its status.');
      if (!running) {
        conversation = target.id;
        history.data.currentId = target.id;
        history.save();
        store.save({ thread: target.thread });
      }
      await handle({ text, from: { id: Number(cfg.owner) }, chat: { id: Number(cfg.owner), type: 'private' } }, 'dashboard');
      return { conversationId: conversation };
    },
  });
  console.log(`Conversation dashboard: http://127.0.0.1:${dashboard.address().port}`);
  if (store.data.active) {
    store.save({ active: false });
    await report('The bridge restarted during a request. It will not replay it automatically. Inspect the project, then ask Codex to continue.');
  }
  console.log(`Listening as @${bot.username}; owner ${cfg.owner}; project ${cfg.cwd}`);
  async function handle(message, source = 'telegram') {
    if (!authorized(message, cfg.owner)) return;
    const reply = (text, role = 'system', id = conversation) => report(text, role, id, source);
    if (!message.text) return reply('This bridge accepts text messages only.');
    const text = message.text.trim();
    if (text) {
      const messageId = history.add(conversation, 'user', text, source);
      if (source === 'dashboard') deliver(conversation, messageId, `You · Dashboard\n\n${text}`);
    }
    const command = text.split(/\s/)[0].split('@')[0].toLowerCase();
    if (command === '/start' || command === '/help') return reply(help);
    if (command === '/status') return reply(`Project: ${cfg.cwd}\nSandbox: ${cfg.sandbox}\nModel: ${modelLabel()}\nAgent: ${selectedAgent()}\nSession: ${store.data.thread || 'new'}\nState: ${running ? 'working' : 'idle'}`);
    if (command === '/stop') { running?.stop(); return reply(running ? 'Stopping current work…' : 'No request is running.'); }
    if (running) return reply('Codex is still working. Use /status or /stop, or resend your message after the reply.');
    if (command === '/agent') {
      const parts = text.split(/\s+/);
      if (parts.length === 1) return reply(`Agent mode: ${selectedAgent()}\n\n/agent auto — apply code-bot-sid instructions when coding work is needed\n/agent coding — use code-bot-sid for each task\n/agent off — use standard Codex behavior\nSettings apply to this conversation. Instructions come from coding-agent/agent.md.`);
      if (parts.length !== 2 || !agentModes.includes(parts[1])) return reply('Usage: /agent auto, /agent coding, or /agent off.');
      history.update(conversation, { agentMode: parts[1] });
      return reply(`Agent mode saved: ${parts[1]}. It applies to this conversation’s next task and survives restarts.`);
    }
    if (command === '/model') {
      const parts = text.split(/\s+/);
      if (parts.length === 1) {
        const models = availableModels.length
          ? availableModels.map(model => `• ${model.name} — /model ${model.id}${model.id === selectedModel() ? ' (current)' : ''}`).join('\n')
          : 'Could not read the model list. Run `codex debug models` locally to check your CLI.';
        return reply(`Current model: ${modelLabel()}\n\nAvailable models:\n${models}\n\nSend /model <model-id> to switch this conversation. Send /model default to use the Codex configured default. Changes apply to your next task.`);
      }
      const model = parts[1];
      if (parts.length !== 2 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) return reply('Usage: /model <model-id> or /model default. Enter one model ID, without spaces or extra options.');
      history.update(conversation, { model: model === 'default' ? null : model });
      return reply(`Model setting saved for this conversation: ${modelLabel()}\nIt applies to your next task and survives restarts. Codex will report an error if your account cannot use this model.`);
    }
    if (command === '/new') { store.save({ thread: null }); conversation = history.select(null, { fresh: true, project: cfg.cwd }); return reply('The next message will start a new conversation. Project files are unchanged.'); }
    if (command === '/resume') {
      const id = text.split(/\s+/)[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) return reply('Usage: /resume <session UUID>. The session must exist locally.');
      store.save({ thread: id });
      conversation = history.select(id, { project: cfg.cwd });
      return reply('Saved session selected. Your next message will attempt to resume it in the configured project.');
    }
    if (text.startsWith('/')) return reply(help);
    if (!text) return;
    const requestConversation = conversation;
    let job;
    try {
      job = runBridgeAgent({ ...cfg, model: selectedModel() }, store.data.thread, text, thread => {
        store.save({ thread });
        history.update(requestConversation, { thread });
      }, selectedAgent());
    } catch (error) { return reply(`Could not start the agent: ${redact(error.message)}`); }
    store.save({ active: true });
    history.update(requestConversation, { status: 'working' });
    running = job;
    activeJob = job;
    const typing = setInterval(() => { telegram.call('sendChatAction', { chat_id: cfg.owner, action: 'typing' }).catch(() => {}); }, 4500);
    // Attach handlers immediately, before any network request can delay them.
    let outcome = 'completed';
    job.done.catch(error => {
      outcome = 'failed';
      return `Request failed: ${redact(error.message)}\nCheck Codex login/limits locally. Use /new if the saved session is unavailable.`;
    })
      .then(async answer => {
        store.save({ active: false });
        history.update(requestConversation, { status: answer === 'Stopped. Changes already made remain on disk.' ? 'stopped' : outcome });
        writeFileSync(resolve(directory, 'last-response.txt'), redact(answer), { mode: 0o600 });
        await reply(answer, outcome === 'failed' ? 'system' : 'assistant', requestConversation);
      }).catch(error => console.error('Could not save request result:', redact(error.message)))
      .finally(() => { clearInterval(typing); running = null; activeJob = null; });
    await reply('Working on your request…');
  }
  while (!shuttingDown) {
    let updates;
    try { updates = await telegram.call('getUpdates', { offset: store.data.offset, timeout: 25, allowed_updates: ['message'] }); }
    catch (error) {
      telegramConnected = false;
      if ([401, 403, 409].includes(error.code)) throw error;
      console.error(error.message);
      await sleep(3000);
      continue;
    }
    telegramConnected = true;
    for (const update of updates) {
      if (shuttingDown) break;
      // Persist before executing: never replay a potentially mutating request after a crash.
      store.save({ offset: update.update_id + 1 });
      await handle(update.message);
    }
  }
}

main().catch(error => { activeJob?.stop(); dashboard?.closeAllConnections(); dashboard?.close(); console.error(error.code === 'EADDRINUSE' ? 'Dashboard port is in use. Stop npm run dashboard, or change DASHBOARD_PORT, then restart.' : error.message); process.exitCode = 1; });
