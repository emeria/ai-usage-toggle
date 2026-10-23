import assert from 'node:assert/strict';
import test from 'node:test';
import { budget, toClaudeEntries, toGeminiContents } from './converter';
import { flattenPath, parseClaude } from './parsers/claude';
import { parseCodex } from './parsers/codex';
import type { Transcript } from './types';

const codexLines = [
  { timestamp: 't0', type: 'session_meta', payload: { id: 'abc-123', cwd: 'c:\\git\\app', git: { branch: 'feat' } } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd></environment_context>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## My request for Codex:\nfix it' }] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Update File: a.ts\n*** End Patch'] }) } },
  { type: 'response_item', payload: { type: 'function_call_output', output: 'HUGE'.repeat(1000) } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
];

test('codex parser strips context, notes patches, drops output', () => {
  const tr = parseCodex(codexLines, 'rollout-x.jsonl')!;
  assert.equal(tr.info.id, 'abc-123');
  assert.equal(tr.info.gitBranch, 'feat');
  assert.deepEqual(tr.turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(tr.turns[0].text, 'fix it');
  assert.deepEqual(tr.turns[1].notes, ['edited a.ts']);
  assert.ok(!JSON.stringify(tr).includes('HUGE'));
});

const claudeLines = [
  { type: 'user', uuid: 'u1', sessionId: 's1', cwd: 'c:\\git\\app', gitBranch: 'feat', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'fix the bug' } },
  { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] } },
  { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'HUGE FILE'.repeat(1000) }] } },
  { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }, { type: 'text', text: 'Fixed.' }] } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
  { type: 'user', timestamp: '2026-01-01T00:00:04Z', message: { role: 'user', content: '<system-reminder>x</system-reminder>now add tests' } },
];

test('claude parser drops tool output, merges replies, keeps edit notes', () => {
  const tr = parseClaude(claudeLines, 'x/s1.jsonl')!;
  assert.equal(tr.info.cwd, 'c:\\git\\app');
  assert.equal(tr.info.gitBranch, 'feat');
  assert.deepEqual(tr.turns.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.match(tr.turns[1].text, /Looking\.\n\nFixed\./);
  assert.deepEqual(tr.turns[1].notes, ['edited a.ts']);
  assert.equal(tr.turns[2].text, 'now add tests');
  assert.ok(!JSON.stringify(tr).includes('HUGE FILE'));
});

test('flattenPath matches Claude project folder names', () => {
  assert.equal(flattenPath('c:\\git\\my-project'), 'c--git-my-project');
});

test('gemini contents alternate and start with user', () => {
  const tr = parseClaude(claudeLines, 'x/s1.jsonl')!;
  const c = toGeminiContents(tr);
  assert.equal(c[0].role, 'user');
  assert.ok(c.every((m, i) => i === 0 || m.role !== c[i - 1].role));
  assert.equal(c[c.length - 1].role, 'model');
  assert.match(c[0].parts[0].text, /Continuing a conversation imported from Claude Code/);
});

test('claude entries chain parentUuid', () => {
  const tr = parseClaude(claudeLines, 'x/s1.jsonl')!;
  const e = toClaudeEntries(tr, 'new', 'c:\\git\\app', 'feat');
  assert.equal(e[0].parentUuid, null);
  assert.equal(e[1].parentUuid, e[0].uuid);
  assert.equal(e[0].sessionId, 'new');
});

test('budget keeps first and newest turns', () => {
  const turns: Transcript['turns'] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(100), notes: [] }));
  const b = budget(turns, { maxChars: 350 });
  assert.equal(b.turns[0], turns[0]);
  assert.equal(b.turns[b.turns.length - 1], turns[9]);
  assert.ok(b.dropped > 0);
});
