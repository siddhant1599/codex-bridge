import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAgentTask, runBridgeAgent } from '../coding-agent/bridge.js';

test('automatic mode supplies the coding profile with a boundary for noncoding tasks', () => {
  const prompt = prepareAgentTask('Fix the login tests');
  assert.match(prompt, /Bridge agent mode: auto/);
  assert.match(prompt, /For other requests, answer normally/);
  assert.match(prompt, /You are code-bot-sid/);
  assert.ok(prompt.endsWith('User request:\nFix the login tests'));
});

test('explicit coding and off modes change instructions without changing the user task', () => {
  const task = 'Review this code\nPreserve my work';
  const prompt = prepareAgentTask(task, 'coding', () => 'Custom project conventions');
  assert.match(prompt, /Use the code-bot-sid coding profile/);
  assert.match(prompt, /Custom project conventions/);
  assert.ok(prompt.endsWith(task));
  const off = prepareAgentTask(task, 'off', () => { throw new Error('Must not read profile'); });
  assert.match(off, /profile from earlier turns is disabled/);
  assert.ok(off.endsWith(task));
});

test('missing or empty profiles fail clearly and invalid agent modes are rejected', () => {
  assert.throws(() => prepareAgentTask('task', 'auto', () => { throw new Error('missing'); }), /Restore that file or use \/agent off/);
  assert.throws(() => prepareAgentTask('task', 'coding', () => ' '), /is empty/);
  assert.throws(() => prepareAgentTask('task', 'unknown'), /Agent mode/);
});

test('agent adapter preserves runner model, workspace, session, callbacks and stop handle', async () => {
  const cfg = { model: 'test-model', cwd: '/target-project', sandbox: 'read-only', timeout: 10 };
  const onThread = () => {};
  let cancelled = false;
  const job = { done: Promise.resolve('result'), stop() { cancelled = true; } };
  const result = runBridgeAgent(cfg, 'saved-session', 'Fix the bug', onThread, 'coding', (config, session, prompt, callback) => {
    assert.equal(config, cfg);
    assert.equal(session, 'saved-session');
    assert.equal(callback, onThread);
    assert.match(prompt, /Bridge agent mode: coding/);
    assert.ok(prompt.endsWith('Fix the bug'));
    return job;
  });
  assert.equal(result, job);
  result.stop();
  assert.equal(cancelled, true);
  assert.equal(await result.done, 'result');
});
