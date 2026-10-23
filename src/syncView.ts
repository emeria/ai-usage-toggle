import * as vscode from 'vscode';
import { checkTarget } from './sync/git';
import { listClaude } from './sync/parsers/claude';
import { listCodex } from './sync/parsers/codex';
import { listGemini } from './sync/parsers/gemini';
import { loadSession } from './sync';
import { writeClaudeSession, writeCodexSession, writeGeminiCheckpoint, writeHandoff } from './sync/converter';
import { TOOL_NAMES as TOOL_NAME, type SessionInfo, type Tool } from './sync/types';
import { truncate } from './sync/util';

const TOOL_ICON: Record<Tool, string> = { claude: 'sparkle', gemini: 'star-empty', codex: 'hubot' };

type Node = { kind: 'tool'; tool: Tool; sessions: SessionInfo[] } | { kind: 'chat'; session: SessionInfo };

export class ChatsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'tool') {
      const item = new vscode.TreeItem(`${TOOL_NAME[n.tool]} (${n.sessions.length})`, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(TOOL_ICON[n.tool]);
      return item;
    }
    const s = n.session;
    const item = new vscode.TreeItem(truncate(s.lastPrompt, 70) || '(no prompt)');
    const where = [s.cwd?.split(/[\\/]/).pop(), s.gitBranch].filter(Boolean).join(' @ ');
    item.description = `${where} · ${s.updatedAt.slice(0, 16).replace('T', ' ')}`;
    item.tooltip = new vscode.MarkdownString(
      `**${TOOL_NAME[s.tool]}** \`${s.id.slice(0, 8)}\`\n\n${s.cwd ?? 'unknown directory'}${s.gitBranch ? `\n\nbranch \`${s.gitBranch}\`` : ''}\n\n${s.turnCount} turns`,
    );
    item.contextValue = 'chat';
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    return item;
  }

  getChildren(n?: Node): Node[] {
    if (n?.kind === 'chat') {
      return [];
    }
    if (n?.kind === 'tool') {
      return n.sessions.map((session) => ({ kind: 'chat' as const, session }));
    }
    const limit = vscode.workspace.getConfiguration('aiUsageToggle').get<number>('sync.sessionLimit', 30);
    // Second accounts keep their chats in their own config folders.
    const dirs = (provider: string) =>
      vscode.workspace
        .getConfiguration('aiUsageToggle')
        .get<{ provider?: string; configDir?: string }[]>('profiles', [])
        .filter((p) => p.provider === provider && p.configDir)
        .map((p) => p.configDir!);
    return [
      { kind: 'tool' as const, tool: 'claude' as const, sessions: listClaude(limit, dirs('claude')) },
      { kind: 'tool' as const, tool: 'gemini' as const, sessions: listGemini(limit) },
      { kind: 'tool' as const, tool: 'codex' as const, sessions: listCodex(limit, dirs('openai')) },
    ];
  }
}

/** Confirm the working directory and branch. Returns the directory to continue in, or undefined to cancel. */
async function confirmTarget(s: SessionInfo): Promise<string | undefined> {
  let dir = s.cwd;
  if (!dir || !checkTarget(dir).dirExists) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Use this folder',
      title: `Folder not found (${dir ?? 'unknown'}). Where should the chat continue?`,
    });
    dir = picked?.[0]?.fsPath;
    if (!dir) {
      return undefined;
    }
  }
  const g = checkTarget(dir, s.gitBranch);
  if (g.isRepo && !g.branchMatches) {
    const stay = `Stay on ${g.branch}`;
    const wt = g.worktreeForBranch ? `Use worktree (${s.gitBranch})` : undefined;
    const choice = await vscode.window.showWarningMessage(
      `This chat was on branch "${s.gitBranch}", but ${dir} is on "${g.branch}".`,
      { modal: true },
      ...(wt ? [wt] : []),
      stay,
    );
    if (choice === wt && g.worktreeForBranch) {
      dir = g.worktreeForBranch;
    } else if (choice !== stay) {
      return undefined;
    }
  }
  if (g.dirty) {
    void vscode.window.showInformationMessage('Note: that folder has uncommitted changes.');
  }
  return dir;
}

export async function pickUpChat(node?: Node): Promise<void> {
  if (node?.kind !== 'chat') {
    return;
  }
  const s = node.session;
  const tr = loadSession(s);
  if (!tr) {
    void vscode.window.showErrorMessage('Could not read that chat.');
    return;
  }
  const others = (['claude', 'gemini', 'codex'] as Tool[]).filter((t) => t !== s.tool);
  const targetTool = (
    await vscode.window.showQuickPick(
      others.map((t) => ({ label: TOOL_NAME[t], tool: t })),
      { title: `Pick up this ${TOOL_NAME[s.tool]} chat in…` },
    )
  )?.tool;
  if (!targetTool) {
    return;
  }
  const dir = await confirmTarget(s);
  if (!dir) {
    return;
  }
  const maxChars = vscode.workspace.getConfiguration('aiUsageToggle').get<number>('sync.maxChars', 60000);
  const opts = { maxChars };

  let command: string;
  let hint: string | undefined;
  try {
    if (targetTool === 'gemini') {
      const { tag } = writeGeminiCheckpoint(tr, dir, opts);
      command = 'gemini';
      hint = `/chat resume ${tag}`;
    } else if (targetTool === 'codex') {
      const { id } = writeCodexSession(tr, dir, s.gitBranch, opts);
      command = `codex resume ${id}`;
    } else {
      const { id } = writeClaudeSession(tr, dir, s.gitBranch, opts);
      command = `claude --resume ${id}`;
    }
    writeHandoff(tr, opts);
  } catch (e) {
    void vscode.window.showErrorMessage(`Pick up failed: ${(e as Error).message}`);
    return;
  }

  const target = TOOL_NAME[targetTool];
  const launch = 'Launch in terminal';
  const choice = await vscode.window.showInformationMessage(
    `Chat ready for ${target}.${hint ? ` After it starts, run: ${hint}` : ''}`,
    launch,
  );
  if (choice === launch) {
    if (hint) {
      await vscode.env.clipboard.writeText(hint);
      void vscode.window.showInformationMessage(`Copied "${hint}" to the clipboard. Paste it in Gemini.`);
    }
    const term = vscode.window.createTerminal({ name: `Pick up in ${target}`, cwd: dir });
    term.show();
    term.sendText(command);
  }
}
