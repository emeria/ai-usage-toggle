import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectsDir, flattenPath } from './parsers/claude';
import { geminiProjectDir } from './parsers/gemini';
import { TOOL_NAMES, type Transcript, type Turn } from './types';

export interface ConvertOptions {
  /** Total character budget for the converted conversation (a rough proxy for tokens). */
  maxChars?: number;
  maxTurnChars?: number;
}

export function renderTurn(t: Turn, maxTurnChars = 3000): string {
  let text = t.text;
  if (text.length > maxTurnChars) {
    text = text.slice(0, maxTurnChars) + `\n[... ${text.length - maxTurnChars} more characters omitted]`;
  }
  if (t.notes.length) {
    text += `${text ? '\n\n' : ''}[Actions taken: ${t.notes.join('; ')}]`;
  }
  return text || '[no text]';
}

/** Keep the first turn and as many of the newest turns as fit the budget. */
export function budget(turns: Turn[], opts: ConvertOptions = {}): { turns: Turn[]; dropped: number } {
  const max = opts.maxChars ?? 60_000;
  const size = (t: Turn) => renderTurn(t, opts.maxTurnChars).length;
  if (turns.length <= 1) {
    return { turns, dropped: 0 };
  }
  let used = size(turns[0]);
  const kept: Turn[] = [];
  for (let i = turns.length - 1; i >= 1; i--) {
    const s = size(turns[i]);
    if (used + s > max && kept.length) {
      break;
    }
    used += s;
    kept.unshift(turns[i]);
  }
  return { turns: [turns[0], ...kept], dropped: turns.length - 1 - kept.length };
}

export function preface(tr: Transcript, dropped: number): string {
  const i = tr.info;
  const where = [i.cwd, i.gitBranch && `branch ${i.gitBranch}`].filter(Boolean).join(', ');
  return (
    `[Continuing a conversation imported from ${TOOL_NAMES[i.tool]} session ${i.id.slice(0, 8)}` +
    `${where ? ` (${where})` : ''}. Tool output was left out; only your messages, the replies, and a summary of file edits and commands are kept.` +
    `${dropped ? ` ${dropped} older turns were omitted.` : ''}]\n\n`
  );
}

interface Msg {
  role: 'user' | 'assistant';
  text: string;
}

/** Merge consecutive same-role turns and make the conversation start with the user. */
export function alternate(turns: Turn[], pre: string, opts: ConvertOptions = {}): Msg[] {
  const msgs: Msg[] = [];
  for (const t of turns) {
    const text = renderTurn(t, opts.maxTurnChars);
    const last = msgs[msgs.length - 1];
    if (last?.role === t.role) {
      last.text += '\n\n' + text;
    } else {
      msgs.push({ role: t.role, text });
    }
  }
  if (msgs[0]?.role !== 'user') {
    msgs.unshift({ role: 'user', text: '[conversation start]' });
  }
  msgs[0].text = pre + msgs[0].text;
  return msgs;
}

/** Gemini `/chat` checkpoint contents: [{role: "user"|"model", parts: [{text}]}]. */
export function toGeminiContents(tr: Transcript, opts: ConvertOptions = {}) {
  const { turns, dropped } = budget(tr.turns, opts);
  const msgs = alternate(turns, preface(tr, dropped), opts);
  if (msgs[msgs.length - 1].role === 'user') {
    msgs.push({ role: 'assistant', text: 'Understood. Ready to continue.' });
  }
  return msgs.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
}

export function toClaudeEntries(tr: Transcript, sessionId: string, cwd: string, gitBranch?: string, opts: ConvertOptions = {}) {
  const { turns, dropped } = budget(tr.turns, opts);
  const msgs = alternate(turns, preface(tr, dropped), opts);
  let parent: string | null = null;
  const base = Date.now() - msgs.length * 1000;
  return msgs.map((m, i) => {
    const uuid = crypto.randomUUID();
    const entry: any = {
      parentUuid: parent,
      isSidechain: false,
      type: m.role,
      message:
        m.role === 'user'
          ? { role: 'user', content: m.text }
          : {
              role: 'assistant',
              model: '<synthetic>',
              type: 'message',
              content: [{ type: 'text', text: m.text }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            },
      uuid,
      timestamp: new Date(base + i * 1000).toISOString(),
      userType: 'external',
      cwd,
      sessionId,
      gitBranch,
      aiChatSync: { from: tr.info.tool, sourceId: tr.info.id },
    };
    parent = uuid;
    return entry;
  });
}

export function writeClaudeSession(tr: Transcript, cwd: string, gitBranch?: string, opts: ConvertOptions = {}) {
  const id = crypto.randomUUID();
  const dir = path.join(claudeProjectsDir(), flattenPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, toClaudeEntries(tr, id, cwd, gitBranch, opts).map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { id, file };
}

export function writeGeminiCheckpoint(tr: Transcript, cwd: string, opts: ConvertOptions = {}) {
  const tag = `sync-${tr.info.id.slice(0, 8)}`;
  const dir = geminiProjectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `checkpoint-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(toGeminiContents(tr, opts), null, 2));
  return { tag, file };
}

/** Codex rollout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl. Resume with `codex resume <id>`. */
export function writeCodexSession(tr: Transcript, cwd: string, gitBranch?: string, opts: ConvertOptions = {}) {
  const id = crypto.randomUUID();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = path.join(os.homedir(), '.codex', 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const { turns, dropped } = budget(tr.turns, opts);
  const base = Date.now() - 60_000;
  const lines: any[] = [
    {
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: { id, timestamp: new Date(base).toISOString(), cwd, originator: 'ai-usage-toggle', source: 'cli', instructions: null, git: gitBranch ? { branch: gitBranch } : undefined },
    },
    ...alternate(turns, preface(tr, dropped), opts).map((m, i) => ({
      timestamp: new Date(base + (i + 1) * 100).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: m.role,
        content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.text }],
      },
    })),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { id, file };
}

/** Plain-text handoff, for when a tool's native resume isn't an option. */
export function writeHandoff(tr: Transcript, opts: ConvertOptions = {}) {
  const { turns, dropped } = budget(tr.turns, opts);
  const body = alternate(turns, preface(tr, dropped), opts)
    .map((m) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.text}`)
    .join('\n\n');
  const file = path.join(os.tmpdir(), `ai-chat-sync-${tr.info.id.slice(0, 8)}.md`);
  fs.writeFileSync(file, body);
  return file;
}
