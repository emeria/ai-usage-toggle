import { listClaude, loadClaude } from './parsers/claude';
import { listCodex, loadCodex } from './parsers/codex';
import { listGemini, loadGemini } from './parsers/gemini';
import type { SessionInfo, Transcript } from './types';

export * from './types';
export * from './converter';
export { checkTarget } from './git';
export { parseClaude, flattenPath } from './parsers/claude';
export { parseCodex } from './parsers/codex';
export { parseGemini } from './parsers/gemini';

export function listAllSessions(limit = 40): SessionInfo[] {
  return [...listClaude(limit), ...listGemini(limit), ...listCodex(limit)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadSession(info: SessionInfo): Transcript | undefined {
  switch (info.tool) {
    case 'claude':
      return loadClaude(info.file);
    case 'codex':
      return loadCodex(info.file);
    default:
      return loadGemini(info.file, info.cwd);
  }
}
