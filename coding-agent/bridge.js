import { readFileSync } from 'node:fs';
import { runCodex } from '../src/core.js';

export const agentModes = ['auto', 'coding', 'off'];

export function prepareAgentTask(text, mode = 'auto', readProfile = () => readFileSync(new URL('./agent.md', import.meta.url), 'utf8')) {
  if (!agentModes.includes(mode)) throw new Error('Agent mode must be auto, coding, or off.');
  if (mode === 'off') {
    return 'For this turn, use standard Codex behavior. The bridge coding-agent profile from earlier turns is disabled. Follow the user request and repository instructions.\n\nUser request:\n' + text;
  }
  let profile;
  try { profile = readProfile().trim(); }
  catch { throw new Error('Cannot read coding-agent/agent.md. Restore that file or use /agent off.'); }
  if (!profile) throw new Error('coding-agent/agent.md is empty. Add instructions or use /agent off.');
  const routing = mode === 'auto'
    ? 'Decide from the user request and conversation whether coding work is needed. For implementation, debugging, tests, code review, repository investigation, or Git work, apply the code-bot-sid profile below. For other requests, answer normally without imposing a coding workflow. Do not ask the user to select an agent when the task is clear.'
    : 'Use the code-bot-sid coding profile below for this request.';
  return `Bridge agent mode: ${mode}\n${routing}\n\nThe profile describes a specialization of this Codex session, not a separate process or tool. Keep the user’s scope and repository instructions authoritative. Work in the configured project directory. Do not launch coding-agent/run.sh from this integration: it is an interactive launcher. Do not change Git identity or invent an email; use existing configuration for requested commits.\n\n<coding_agent_profile>\n${profile}\n</coding_agent_profile>\n\nUser request:\n${text}`;
}

export function runBridgeAgent(cfg, thread, task, onThread, mode = 'auto', runner = runCodex) {
  // Use the same runner so cancellation, model overrides, and session resumption remain intact.
  return runner(cfg, thread, prepareAgentTask(task, mode), onThread);
}
