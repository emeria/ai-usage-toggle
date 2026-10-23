export type Tool = 'claude' | 'gemini' | 'codex';

export const TOOL_NAMES: Record<Tool, string> = { claude: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };

/** One side of a conversation, with noisy tool output already dropped. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  ts?: string;
  /** High-level actions only, e.g. "edited src/a.ts", "ran: npm test". */
  notes: string[];
}

export interface SessionInfo {
  tool: Tool;
  id: string;
  file: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  updatedAt: string;
  lastPrompt: string;
  turnCount: number;
}

export interface Transcript {
  info: SessionInfo;
  turns: Turn[];
}
