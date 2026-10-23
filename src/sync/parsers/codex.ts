import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionInfo, Transcript, Turn } from '../types';
import { newestFirst, readJsonl, truncate } from '../util';

export const codexSessionsDir = (): string => path.join(os.homedir(), '.codex', 'sessions');

const SKIP_USER = /^\s*(<(environment_context|user_instructions|user_action|INSTRUCTIONS)>|# AGENTS\.md instructions)/;
const IDE_PREFIX = /^[\s\S]*?## My request for Codex:\s*/;

function blocksText(content: any): string {
  return Array.isArray(content)
    ? content.filter((b) => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text').map((b) => b.text).join('\n')
    : '';
}

/** One-line note for a Codex tool call; the shell tool also carries file patches. */
function callNote(p: any): string | undefined {
  let args: any;
  try {
    args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments;
  } catch {
    return undefined;
  }
  const cmd = Array.isArray(args?.command) ? args.command.join(' ') : args?.command;
  if (typeof cmd !== 'string') {
    return undefined;
  }
  if (/\bapply_patch\b/.test(cmd)) {
    const files = [...cmd.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim());
    return files.length ? `edited ${files.join(', ')}` : 'edited files (apply_patch)';
  }
  // Skip pure reads so the notes stay about what changed.
  if (/^(pwsh(\.exe)?|powershell(\.exe)?|bash|sh)\b.*\b(Get-Content|cat|ls|dir|Get-ChildItem|rg|grep|sed -n)\b/.test(cmd) && !/[>|]\s*\S/.test(cmd.replace(/\|\s*(Select|head|tail|Out-String)/g, ''))) {
    return undefined;
  }
  return `ran: ${truncate(cmd, 120)}`;
}

export function parseCodex(lines: any[], file: string): Transcript | undefined {
  const turns: Turn[] = [];
  let id = path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-/, '');
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;

  for (const o of lines) {
    // Older rollouts have bare items; newer ones wrap them as {timestamp, type, payload}.
    const p = o.payload ?? o;
    if (o.timestamp) {
      startedAt ??= o.timestamp;
      updatedAt = o.timestamp;
    }
    if (o.type === 'session_meta') {
      id = p.id ?? id;
      cwd = p.cwd ?? cwd;
      gitBranch = p.git?.branch ?? gitBranch;
      continue;
    }
    if (p.type === 'message' && p.role === 'user') {
      const raw = blocksText(p.content);
      if (SKIP_USER.test(raw)) {
        continue;
      }
      const text = raw.replace(IDE_PREFIX, '').trim();
      if (text) {
        turns.push({ role: 'user', text, ts: o.timestamp, notes: [] });
      }
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = blocksText(p.content).trim();
      const prev = turns[turns.length - 1];
      if (prev?.role === 'assistant') {
        prev.text = [prev.text, text].filter(Boolean).join('\n\n');
      } else if (text) {
        turns.push({ role: 'assistant', text, ts: o.timestamp, notes: [] });
      }
    } else if (p.type === 'function_call') {
      const note = callNote(p);
      if (!note) {
        continue;
      }
      let last = turns[turns.length - 1];
      if (last?.role !== 'assistant') {
        last = { role: 'assistant', text: '', ts: o.timestamp, notes: [] };
        turns.push(last);
      }
      if (!last.notes.includes(note)) {
        last.notes.push(note);
      }
    }
  }
  if (!turns.some((t) => t.role === 'user')) {
    return undefined;
  }
  const lastUser = [...turns].reverse().find((t) => t.role === 'user');
  const info: SessionInfo = {
    tool: 'codex',
    id,
    file,
    cwd,
    gitBranch,
    startedAt,
    updatedAt: updatedAt ?? fs.statSync(file).mtime.toISOString(),
    lastPrompt: truncate(lastUser?.text ?? '', 200),
    turnCount: turns.length,
  };
  return { info, turns };
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
}

export function loadCodex(file: string): Transcript | undefined {
  return parseCodex(readJsonl(file), file);
}

/** `homes` are extra CODEX_HOME folders (second accounts) to scan besides ~/.codex. */
export function listCodex(limit = 40, homes: string[] = []): SessionInfo[] {
  const files: string[] = [];
  walk(codexSessionsDir(), files);
  homes.forEach((h) => walk(path.join(h, 'sessions'), files));
  const out: SessionInfo[] = [];
  for (const f of newestFirst(files)) {
    if (out.length >= limit) {
      break;
    }
    const t = loadCodex(f);
    if (t) {
      out.push(t.info);
    }
  }
  return out;
}
