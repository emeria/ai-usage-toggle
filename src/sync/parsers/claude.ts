import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionInfo, Transcript, Turn } from '../types';
import { editNote, newestFirst, readJsonl, truncate } from '../util';

export const claudeProjectsDir = (): string => path.join(os.homedir(), '.claude', 'projects');

/** Claude Code names project folders by replacing every non-alphanumeric char with "-". */
export const flattenPath = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-');

const NOISE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-std(?:out|err)>[\s\S]*?<\/local-command-std(?:out|err)>/g,
  /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g,
];

function cleanUser(text: string): string {
  let t = text;
  for (const re of NOISE) {
    t = t.replace(re, '');
  }
  return t.trim();
}

export function parseClaude(lines: any[], file: string): Transcript | undefined {
  const turns: Turn[] = [];
  let id = path.basename(file, '.jsonl');
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;

  for (const o of lines) {
    if (o.sessionId) {
      id = o.sessionId;
    }
    if (o.cwd) {
      cwd = o.cwd;
    }
    if (o.gitBranch) {
      gitBranch = o.gitBranch;
    }
    if (o.timestamp) {
      startedAt ??= o.timestamp;
      updatedAt = o.timestamp;
    }
    if (o.isSidechain || o.isMeta) {
      continue;
    }
    const content = o.message?.content;
    if (o.type === 'user') {
      const raw = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
          : '';
      const text = cleanUser(raw);
      if (text) {
        turns.push({ role: 'user', text, ts: o.timestamp, notes: [] });
      }
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      const notes = content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => editNote(b.name, b.input))
        .filter((n: string | undefined): n is string => !!n);
      if (!text && !notes.length) {
        continue;
      }
      // Claude writes one line per content block, so consecutive assistant lines are one reply.
      const prev = turns[turns.length - 1];
      if (prev?.role === 'assistant') {
        prev.text = [prev.text, text].filter(Boolean).join('\n\n');
        prev.notes.push(...notes.filter((n) => !prev.notes.includes(n)));
      } else {
        turns.push({ role: 'assistant', text, ts: o.timestamp, notes: [...new Set(notes)] });
      }
    }
  }
  if (!turns.length) {
    return undefined;
  }
  const lastUser = [...turns].reverse().find((t) => t.role === 'user');
  const info: SessionInfo = {
    tool: 'claude',
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

/** `configDirs` are extra CLAUDE_CONFIG_DIR folders (second accounts) to scan besides ~/.claude. */
export function claudeFiles(configDirs: string[] = []): string[] {
  const files: string[] = [];
  for (const root of [claudeProjectsDir(), ...configDirs.map((d) => path.join(d, 'projects'))]) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jsonl')) {
          files.push(path.join(dir, f));
        }
      }
    }
  }
  return newestFirst(files);
}

export function loadClaude(file: string): Transcript | undefined {
  return parseClaude(readJsonl(file), file);
}

export function listClaude(limit = 40, configDirs: string[] = []): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const f of claudeFiles(configDirs)) {
    if (out.length >= limit) {
      break;
    }
    const t = loadClaude(f);
    if (t) {
      out.push(t.info);
    }
  }
  return out;
}
