import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaReturnCandidate } from './quota-fallback';
import { delegationTasks, delegationWorkers } from './conversation';
import type { Session, SessionEvent } from '../server/types';
const now = Date.parse('2026-10-30T12:00:00Z');
const handoff = { id: 'h', sessionId: 's', agent: 'claude', type: 'handoff', text: 'switch', time: new Date(now - 10000).toISOString(), metadata: { quotaFallback: true, from: 'codex', to: 'claude', resetsAt: now / 1000 - 1 } } as SessionEvent;
const base: Session = { id: 's', workspaceId: 'personal', title: 'task', agent: 'claude', workers: ['grok'], cwd: '/tmp', status: 'done', createdAt: '', events: [handoff] };
test('quota return is offered after reset, never during a run or for disallowed source', () => {
  assert.equal(quotaReturnCandidate(base, [], 3, ['codex', 'claude'], now)?.id, 'h');
  assert.equal(quotaReturnCandidate({ ...base, status: 'running' }, [], 3, ['codex', 'claude'], now), undefined);
  assert.equal(quotaReturnCandidate(base, [], 3, ['claude', 'grok'], now), undefined);
});
test('current exhausted quota and later handoffs prevent stale return offers', () => {
  const quota = { agent: 'codex' as const, updatedAt: new Date(now).toISOString(), windows: [{ key: 'week', label: 'week', remainingPercent: 1, resetsAt: now / 1000 + 100 }] };
  assert.equal(quotaReturnCandidate(base, [quota], 3, ['codex'], now), undefined);
  assert.equal(quotaReturnCandidate({ ...base, events: [handoff, { ...handoff, id: 'manual', metadata: undefined }] }, [], 3, ['codex'], now), undefined);
});
test('worker fallback retains task id, history and current provider logo', () => {
  const e = (id: string, agent: SessionEvent['agent'], type: SessionEvent['type'], text: string): SessionEvent => ({ id, agent, type, text, role: 'worker', delegationId: 'task', sessionId: 's', time: new Date(now).toISOString() });
  const s = { ...base, events: [e('task', 'codex', 'delegation', 'Implement'), e('old', 'codex', 'error', 'usage limit'), e('retry', 'claude', 'status', 'retrying'), { ...e('done', 'claude', 'status', 'done'), taskStatus: 'done' as const }] };
  const task = delegationTasks(s, now)[0];
  assert.equal(task.event.id, 'task');
  assert.equal(task.event.agent, 'claude');
  assert.equal(task.status, 'done');
  assert.equal(task.thread.length, 3);
  assert.equal(delegationWorkers(s, now)[0].agent, 'claude');
});
test('a fallback worker remains running while retaining the earlier quota error', () => {
  const common = { sessionId: 's', role: 'worker' as const, delegationId: 'task', time: new Date(now).toISOString() };
  const s: Session = { ...base, status: 'running', events: [
    { ...common, id: 'task', type: 'delegation', agent: 'codex', text: 'work', taskStatus: 'running' },
    { ...common, id: 'limit', type: 'error', agent: 'codex', text: 'usage limit' },
    { ...common, id: 'retry', type: 'status', agent: 'claude', text: 'retry', taskStatus: 'running' },
  ] };
  assert.equal(delegationTasks(s, now)[0].status, 'running');
});
