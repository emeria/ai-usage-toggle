# AI Usage Toggle

Status bar switch between account/subscription and API-key usage for Claude, Gemini, and OpenAI.

| Mode id | Status bar | Effect |
| --- | --- | --- |
| `claude-max` | `$(sparkle) Claude: Max` | no key injected (Max/Account login) |
| `claude-api` | `$(key) Claude: API` | injects `ANTHROPIC_API_KEY` |
| `gemini-account` | `$(sparkle) Gemini: Account` | no key injected |
| `gemini-api` | `$(key) Gemini: API` | injects `GEMINI_API_KEY` |
| `openai-account` | `$(account) OpenAI: Account` | no key injected |
| `openai-api` | `$(key) OpenAI: API` | injects `OPENAI_API_KEY` |

Only one mode is active at a time. Switching removes every other managed key from the environment.

- Keys live in VS Code `SecretStorage` (Windows Credential Manager / macOS Keychain), one per provider.
- Env vars are injected via `environmentVariableCollection` (non-persistent, so keys are never written to VS Code state files; re-applied at startup).
- The active mode survives restarts (`globalState`).

## AI Chat Sync

The **AI Chat Sync** view (Explorer sidebar) lists recent Claude Code, Gemini, and Codex (OpenAI) chats, each with project, branch, and time. Click the arrow button on a chat (or right-click, **Pick Up in Other Tool**), then choose which tool to continue in.

- Checks git first: if the folder is on a different branch than the chat, it offers the worktree that has the branch, or lets you stay.
- Keeps your messages, the replies, and one-line notes like `edited a.ts` or `ran: npm test`. Drops tool output and thinking. Capped by `aiUsageToggle.sync.maxChars`.
- Claude to Gemini: writes a Gemini checkpoint. **Launch in terminal** opens `gemini` in the folder and copies `/chat resume sync-<id>` to your clipboard.
- To Claude: writes a Claude session and launches `claude --resume <id>`.
- To Codex: writes a rollout under `~/.codex/sessions/` and launches `codex resume <id>`. Reading Codex chats is checked against real rollout files; **writing one is untested**, so please report problems.
- The launched terminal inherits the current usage mode's API key, so toggle first, then pick up.
- Not yet verified against the real tools; see the notes in `src/sync/`. A plain-text copy is also written to your temp folder as a fallback.

## Settings

- `aiUsageToggle.sync.sessionLimit` (default 30 per tool) and `aiUsageToggle.sync.maxChars` (default 60000).

- `aiUsageToggle.order`: the modes you use, in toggle order. A mode that is not listed is disabled. Default: `["claude-max", "claude-api"]`. Edit it in Settings to reorder; use **AI Usage: Choose Modes** to tick modes on and off.
- `aiUsageToggle.clickBehavior`: `cycle` (default, next mode in order) or `menu` (pick list).
- `aiUsageToggle.profiles`: your own named modes, as many as you like. Easiest way to add one: **AI Usage: Add Profile** (pick provider, type, name). Each profile appears in **Choose Modes** and in `order` as `p:<name>`. The name is what the status bar shows.
  - `account`: a subscription login. Give it a `configDir` to keep a second account. It is set as `CLAUDE_CONFIG_DIR` (Claude), `CODEX_HOME` (OpenAI), or `GEMINI_CLI_HOME` (Gemini). Run the tool once in that mode (the wizard offers **Open login terminal**) to log in. The `GEMINI_CLI_HOME` name is unverified.
  - `api`: a key. Each profile has its own key in the credential vault, so you can have two Claude keys. Use **AI Usage: Set API Key** to change one.
  - `local`: an OpenAI-compatible server. Sets `OPENAI_BASE_URL` and `OPENAI_API_KEY` (placeholder `local`).
  - Optional `env` map and `icon` (codicon name) on any profile.

```json
"aiUsageToggle.profiles": [
  { "name": "Work Max", "type": "account", "provider": "claude", "configDir": "C:\\Users\\me\\.claude-work", "icon": "briefcase" },
  { "name": "Personal key", "type": "api", "provider": "claude" },
  { "name": "Ollama", "type": "local", "baseUrl": "http://localhost:11434/v1" }
],
"aiUsageToggle.order": ["claude-max", "p:Work Max", "p:Personal key", "p:Ollama"]
```

Chats from a second Claude or Codex account's config folder also show up in the AI Chat Sync view. A chat picked up *into* Claude or Codex is always written to the default login folder.

The `apiKey` field on local profiles is plain text in settings; use only a placeholder.

## Commands

| Command | Action |
| --- | --- |
| `aiUsageToggle.toggle` (also `toggleMode`) | Next mode in order (or the pick list, per `clickBehavior`) |
| `aiUsageToggle.pickMode` | Pick a mode from a list |
| `aiUsageToggle.chooseModes` | Enable or disable modes |
| `aiUsageToggle.addProfile` | Add a named account, API key, or local server |
| `aiUsageToggle.setApiKey` | Set or update a provider's key (masked input) |
| `aiUsageToggle.clearApiKey` | Delete a provider's key |

If the active API mode's key is cleared, the extension falls back to an enabled account mode.

## Build and run

```powershell
npm install
npm run compile
```

Press **F5** to open the Extension Development Host.

## Package and install

```powershell
npx vsce package
code --install-extension ai-usage-toggle-0.0.1.vsix
```

(Or in VS Code: Extensions view → `...` → Install from VSIX.)

## Claude Remote Control

With `ANTHROPIC_API_KEY` set, Claude Code warns "Remote Control requires claude.ai subscription auth". Switching to `claude-api` shows a warning about this, and the tooltip notes it. Switch back to `claude-max` to use Remote Control.

## Caveat

`environmentVariableCollection` only affects **integrated terminals** opened after the change. It does not change the environment of the extension host, so extension panels (such as the Claude Code panel) may not see the key. Run the CLI in an integrated terminal, or reload the window after switching, and check which auth it reports.