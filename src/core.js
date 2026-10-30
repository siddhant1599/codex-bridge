import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, fstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';

export function config(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[\w-]+$/.test(token)) throw new Error('Set TELEGRAM_BOT_TOKEN in .env.');
  const sandbox = env.CODEX_SANDBOX || 'workspace-write';
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) throw new Error('Invalid CODEX_SANDBOX.');
  if (sandbox === 'danger-full-access' && env.CODEX_ALLOW_FULL_ACCESS !== 'true') throw new Error('CODEX_SANDBOX=danger-full-access requires CODEX_ALLOW_FULL_ACCESS=true.');
  const timeout = Number(env.CODEX_TIMEOUT_SECONDS || 1800);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400) throw new Error('Timeout must be between 1 and 86400 seconds.');
  const homeConfig = resolve(env.CODEX_HOME || resolve(homedir(), '.codex'), 'config.toml');
  let configuredModel = '';
  try {
    const toml = readFileSync(homeConfig, 'utf8');
    configuredModel = toml.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = env.CODEX_MODEL?.trim() || configuredModel;
  return { token, owner: env.TELEGRAM_ALLOWED_USER_ID?.trim(), sandbox, timeout, githubEnabled: Boolean(env.GH_TOKEN?.trim()),
    cwd: resolve(env.CODEX_WORKDIR || '.'), bin: env.CODEX_BIN || 'codex', model };
}

export function listAvailableModels(bin = 'codex', exec = execFileSync) {
  const raw = exec(bin, ['debug', 'models'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const data = JSON.parse(raw.trim());
  if (!Array.isArray(data.models)) throw new Error('Codex returned an invalid model catalog.');
  return data.models.filter(item => item.visibility === 'list' && typeof item.slug === 'string')
    .map(({ slug, display_name: name, description }) => ({ id: slug, name: name || slug, description: description || '' }));
}

export function authorized(message, owner) {
  return /^\d+$/.test(owner || '') && message?.chat?.type === 'private'
    && String(message.from?.id) === owner && String(message.chat.id) === owner && !message.from?.is_bot;
}

export function chunks(text, limit = 4000) {
  const result = [];
  let part = '';
  for (const char of text) {
    if (part.length + char.length > limit) { result.push(part); part = ''; }
    part += char;
  }
  if (part) result.push(part);
  return result;
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = resolve(directory, 'state.json');
    try { this.data = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { offset: 0, thread: null, active: false }; }
  }
  save(patch) {
    Object.assign(this.data, patch);
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}

export function lock(directory, { probe = pid => process.kill(pid, 0), log = console.log } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'bridge.lock');
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      let contents;
      try {
        const existing = openSync(path, 'r');
        try { previous = fstatSync(existing); contents = readFileSync(existing, 'utf8').trim(); }
        finally { closeSync(existing); }
      } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      const pid = Number(contents);
      if (!/^\d+$/.test(contents) || !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) {
        throw new Error(`Bridge lock at ${path} has no valid PID. It may be starting; wait a moment and retry. If it persists, check for running bridges before removing it.`);
      }
      try { probe(pid); }
      catch (probeError) {
        // EPERM means the process may exist but cannot be inspected. Never treat it as stale.
        if (probeError.code !== 'ESRCH') throw new Error(`Cannot verify bridge process ${pid}; keeping its lock. Stop it from its original terminal before restarting.`);
        try {
          if (!sameFile(previous, statSync(path)) || readFileSync(path, 'utf8').trim() !== contents) continue;
          unlinkSync(path);
        } catch (removeError) { if (removeError.code === 'ENOENT') continue; throw removeError; }
        log(`Removed stale bridge lock for exited process ${pid}. Starting a new connection.`);
        continue;
      }
      throw new Error(`Bridge lock exists: process ${pid} is still running. Press Ctrl+C in its terminal before starting another bridge.`);
    }
    let owned;
    try { writeFileSync(fd, String(process.pid)); owned = fstatSync(fd); }
    finally { closeSync(fd); }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (sameFile(owned, statSync(path)) && readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  throw new Error('Bridge startup changed concurrently. Wait a moment and run npm start again.');
}

export function codexArgs(cfg, thread) {
  const args = ['-c', 'approval_policy="never"', '-c', `sandbox_mode="${cfg.sandbox}"`];
  if (cfg.githubEnabled) {
    // Pass the credential through the environment, never command-line arguments.
    const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_*', 'TERM', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
    args.push('-c', `shell_environment_policy={inherit="all",ignore_default_excludes=true,include_only=${JSON.stringify(names)}}`);
  }
  args.push('exec');
  if (thread) args.push('resume', thread);
  args.push('--json', '--skip-git-repo-check');
  if (cfg.model) args.push('--model', cfg.model);
  args.push('-');
  return args;
}

export function secretRedactor(env = process.env) {
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.GH_TOKEN, env.GITHUB_TOKEN].filter(Boolean).sort((a, b) => b.length - a.length);
  return text => secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), String(text));
}

export function runCodex(cfg, thread, prompt, onThread, spawnProcess = spawn) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TELEGRAM_')) delete env[key];
  const child = spawnProcess(cfg.bin, codexArgs(cfg, thread), {
    cwd: cfg.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let stopped = false;
  let timedOut = false;
  let killTimer;
  const signal = (sig) => {
    try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal('SIGTERM');
    killTimer = setTimeout(() => signal('SIGKILL'), 5000);
    killTimer.unref();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, cfg.timeout * 1000);
  const done = new Promise((resolvePromise, reject) => {
    let answer = '';
    let failure = '';
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started' && event.thread_id) {
        try { onThread(event.thread_id); } catch { failure = 'Could not persist the conversation.'; stop(); }
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text || answer;
      if (event.type === 'turn.failed') failure = event.error?.message || 'Codex turn failed.';
      if (event.type === 'error') failure = event.message || 'Codex reported an error.';
    });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); lines.close(); };
    child.once('error', () => { cleanup(); reject(new Error('Could not launch Codex. Check CODEX_BIN and your installation.')); });
    child.once('close', code => {
      cleanup();
      if (timedOut) return reject(new Error('Request timed out. Files may contain partial changes; inspect them before retrying.'));
      if (failure) return reject(new Error(failure));
      if (stopped) return resolvePromise('Stopped. Changes already made remain on disk.');
      if (code !== 0) return reject(new Error(stderr || `Codex exited with code ${code}.`));
      resolvePromise(answer || 'Codex finished without a text response.');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
  return { done, stop };
}
