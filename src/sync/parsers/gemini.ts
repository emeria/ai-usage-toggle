import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionInfo, Transcript, Turn } from '../types';
import { editNote, newestFirst, normPath, readJsonl, truncate } from '../util';

export const geminiDir = (): string => path.join(os.homedir(), '.gemini');
export const geminiTmpDir = (): string => path.join(geminiDir(), 'tmp');

function readProjectsMap(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(geminiDir(), 'projects.json'), 'utf8')).projects ?? {};
  } catch {
    return {};
  }
}

/** Project dir under ~/.gemini/tmp for a working directory (slug from projects.json, else sha256 of the path). */
export function geminiProjectDir(cwd: string): string {
  const slug = Object.entries(readProjectsMap()).find(([p]) => normPath(p) === normPath(cwd))?.[1];
  return path.join(geminiTmpDir(), slug ?? crypto.createHash('sha256').update(cwd).digest('hex'));
}

function cwdForProjectDir(dir: string): string | undefined {
  try {
    const t = fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim();
    if (t) {
      return t;
    }
  } catch {
    // fall through to projects.json
  }
  const slug = path.basename(dir);
  return Object.entries(readProjectsMap()).find(([, s]) => s === slug)?.[0];
}

function textOf(content: any): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  return '';
}

/** Gemini CLI message ("user"/"gemini") or API Content ({role, parts}) to a Turn. */
function toTurn(m: any): Turn | undefined {
  const isUser = m.type === 'user' || m.role === 'user';
  const isModel = m.type === 'gemini' || m.role === 'model';
  if (!isUser && !isModel) {
    return undefined;
  }
  const text = textOf(m.content ?? m.parts).trim();
  if (isUser && (text.startsWith('<session_context>') || !text)) {
    return undefined;
  }
  const calls: any[] = [
    ...(m.toolCalls ?? []).map((c: any) => ({ name: c.name, args: c.args })),
    ...(m.parts ?? []).filter((p: any) => p.functionCall).map((p: any) => p.functionCall),
  ];
  const notes = [...new Set(calls.map((c) => editNote(c.name, c.args)).filter((n): n is string => !!n))];
  if (!text && !notes.length) {
    return undefined;
  }
  return { role: isUser ? 'user' : 'assistant', text, ts: m.timestamp, notes };
}

/**
 * Handles every layout seen so far: a single JSON object with `messages`, a bare Content[] checkpoint,
 * and the event-sourced JSONL (header lines plus `{"$set":{"messages":[...]}}` snapshots and bare messages).
 */
export function parseGemini(file: string, fallbackCwd?: string): Transcript | undefined {
  const raw = fs.readFileSync(file, 'utf8');
  let messages: any[] = [];
  let id = path.basename(file).replace(/\.jsonl?$/, '');
  let startedAt: string | undefined;
  let updatedAt: string | undefined;

  const upsert = (m: any) => {
    const i = m.id ? messages.findIndex((x) => x.id === m.id) : -1;
    if (i >= 0) {
      messages[i] = m;
    } else {
      messages.push(m);
    }
  };

  if (file.endsWith('.jsonl')) {
    for (const o of readJsonl(file)) {
      if (o.sessionId && o.startTime) {
        id = o.sessionId === 'a2a-server' ? id : o.sessionId;
        startedAt ??= o.startTime;
        updatedAt = o.lastUpdated ?? updatedAt;
      }
      if (o.$set?.messages) {
        o.$set.messages.forEach(upsert);
        updatedAt = o.$set.lastUpdated ?? updatedAt;
      } else if (o.type && (o.content !== undefined || o.parts)) {
        upsert(o);
      } else if (Array.isArray(o.messages)) {
        o.messages.forEach(upsert);
      }
    }
  } else {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) {
        messages = j;
      } else if (Array.isArray(j.messages)) {
        messages = j.messages;
        id = j.sessionId ?? id;
        startedAt = j.startTime;
        updatedAt = j.lastUpdated;
      }
    } catch {
      return undefined;
    }
  }

  const turns = messages.map(toTurn).filter((t): t is Turn => !!t);
  if (!turns.length) {
    return undefined;
  }
  const lastUser = [...turns].reverse().find((t) => t.role === 'user');
  const info: SessionInfo = {
    tool: 'gemini',
    id,
    file,
    cwd: fallbackCwd,
    startedAt,
    updatedAt: updatedAt ?? turns[turns.length - 1].ts ?? fs.statSync(file).mtime.toISOString(),
    lastPrompt: truncate(lastUser?.text ?? '', 200),
    turnCount: turns.length,
  };
  return { info, turns };
}

export function geminiFiles(): { file: string; cwd?: string }[] {
  const root = geminiTmpDir();
  if (!fs.existsSync(root)) {
    return [];
  }
  const out: { file: string; cwd?: string }[] = [];
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) {
      continue;
    }
    const cwd = cwdForProjectDir(dir);
    const scan = (sub: string, re: RegExp) => {
      const p = path.join(dir, sub);
      if (fs.existsSync(p)) {
        for (const f of fs.readdirSync(p)) {
          if (re.test(f)) {
            out.push({ file: path.join(p, f), cwd });
          }
        }
      }
    };
    scan('chats', /\.jsonl?$/);
    scan('.', /^checkpoint-.*\.json$/);
  }
  const order = newestFirst(out.map((o) => o.file));
  return order.map((f) => out.find((o) => o.file === f)!);
}

export function loadGemini(file: string, cwd?: string): Transcript | undefined {
  return parseGemini(file, cwd);
}

export function listGemini(limit = 40): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const { file, cwd } of geminiFiles()) {
    if (out.length >= limit) {
      break;
    }
    const t = parseGemini(file, cwd);
    if (t) {
      out.push(t.info);
    }
  }
  return out;
}
