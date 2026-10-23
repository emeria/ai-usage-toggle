import * as vscode from 'vscode';
import { ChatsProvider, pickUpChat } from './syncView';

interface ModeDef {
  id: string;
  label: string; // status bar text after the icon
  icon: string;
  desc: string;
  /** Env var that gets the stored key in this mode. */
  envVar?: string;
  /** SecretStorage key; present only for API modes. */
  secret?: string;
  /** Fixed env vars injected in this mode (config folders, local base URLs). */
  env?: Record<string, string>;
}

type Provider = 'claude' | 'gemini' | 'openai';

interface Profile {
  name?: string;
  provider?: Provider;
  type?: 'account' | 'api' | 'local';
  /** Separate login folder for an account profile (CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME). */
  configDir?: string;
  baseUrl?: string;
  apiKey?: string;
  env?: Record<string, string>;
  icon?: string;
}

const PROVIDERS: Record<Provider, { label: string; keyVar: string; configVar: string }> = {
  claude: { label: 'Claude', keyVar: 'ANTHROPIC_API_KEY', configVar: 'CLAUDE_CONFIG_DIR' },
  gemini: { label: 'Gemini', keyVar: 'GEMINI_API_KEY', configVar: 'GEMINI_CLI_HOME' },
  openai: { label: 'OpenAI', keyVar: 'OPENAI_API_KEY', configVar: 'CODEX_HOME' },
};

const MODES: ModeDef[] = [
  { id: 'claude-max', label: 'Claude: Max', icon: 'sparkle', desc: 'Claude Max / Account login' },
  { id: 'claude-api', label: 'Claude: API', icon: 'key', desc: 'Anthropic API credits', envVar: 'ANTHROPIC_API_KEY', secret: 'aiUsageToggle.key.claude-api' },
  { id: 'gemini-account', label: 'Gemini: Account', icon: 'sparkle', desc: 'Gemini Google account login' },
  { id: 'gemini-api', label: 'Gemini: API', icon: 'key', desc: 'Gemini API key', envVar: 'GEMINI_API_KEY', secret: 'aiUsageToggle.key.gemini-api' },
  { id: 'openai-account', label: 'OpenAI: Account', icon: 'account', desc: 'OpenAI / ChatGPT account login' },
  { id: 'openai-api', label: 'OpenAI: API', icon: 'key', desc: 'OpenAI API key', envVar: 'OPENAI_API_KEY', secret: 'aiUsageToggle.key.openai-api' },
];

const MODE_KEY = 'aiUsageToggle.mode';
const DEFAULT_ORDER = ['claude-max', 'claude-api'];

/** User-defined profiles from settings, each exposed as a mode with id "p:<name>". */
function profileToMode(p: Profile): ModeDef | undefined {
  const name = p.name?.trim();
  if (!name) {
    return undefined;
  }
  const id = `p:${name}`;
  if (p.type === 'local') {
    if (!p.baseUrl) {
      return undefined;
    }
    return {
      id,
      label: name,
      icon: p.icon ?? 'server',
      desc: `Local AI at ${p.baseUrl}`,
      env: { OPENAI_BASE_URL: p.baseUrl, OPENAI_API_KEY: p.apiKey || 'local', ...p.env },
    };
  }
  const prov = p.provider && PROVIDERS[p.provider];
  if (!prov) {
    return undefined;
  }
  if (p.type === 'api') {
    return {
      id,
      label: name,
      icon: p.icon ?? 'key',
      desc: `${prov.label} API key`,
      envVar: prov.keyVar,
      secret: `aiUsageToggle.key.${id}`,
      env: p.env,
    };
  }
  return {
    id,
    label: name,
    icon: p.icon ?? 'sparkle',
    desc: `${prov.label} account${p.configDir ? ` (${p.configDir})` : ''}`,
    env: { ...(p.configDir ? { [prov.configVar]: p.configDir } : {}), ...p.env },
  };
}

const getProfiles = (): Profile[] => vscode.workspace.getConfiguration('aiUsageToggle').get<Profile[]>('profiles', []);

function profileModes(): ModeDef[] {
  const seen = new Set<string>();
  const out: ModeDef[] = [];
  for (const p of getProfiles()) {
    const m = profileToMode(p);
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

const allModes = (): ModeDef[] => [...MODES, ...profileModes()];
const byId = (id: string) => allModes().find((m) => m.id === id);

let statusItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Keep keys out of VS Code's on-disk state: re-applied on every activation instead.
  context.environmentVariableCollection.persistent = false;

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'aiUsageToggle.toggle';
  context.subscriptions.push(statusItem);

  const chats = new ChatsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiUsageToggle.chats', chats),
    vscode.commands.registerCommand('aiUsageToggle.refreshChats', () => chats.refresh()),
    vscode.commands.registerCommand('aiUsageToggle.pickUpChat', (node) => pickUpChat(node)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiUsageToggle.toggle', () => toggle(context)),
    // Alias for the toggleMode name used in the original spec.
    vscode.commands.registerCommand('aiUsageToggle.toggleMode', () => toggle(context)),
    vscode.commands.registerCommand('aiUsageToggle.pickMode', () => pickMode(context)),
    vscode.commands.registerCommand('aiUsageToggle.chooseModes', () => chooseModes()),
    vscode.commands.registerCommand('aiUsageToggle.addProfile', () => addProfile(context)),
    vscode.commands.registerCommand('aiUsageToggle.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('aiUsageToggle.clearApiKey', () => clearApiKey(context)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiUsageToggle')) {
        void apply(context, getMode(context));
        chats.refresh();
      }
    }),
  );

  await apply(context, getMode(context));
  statusItem.show();
}

export function deactivate(): void {}

/** Enabled modes, in toggle order. The `order` setting is both the order and the enabled list. */
function enabledModes(): ModeDef[] {
  const raw = vscode.workspace.getConfiguration('aiUsageToggle').get<string[]>('order', DEFAULT_ORDER);
  const seen = new Set<string>();
  const list: ModeDef[] = [];
  for (const id of raw) {
    const m = byId(id);
    if (m && !seen.has(id)) {
      seen.add(id);
      list.push(m);
    }
  }
  return list.length ? list : DEFAULT_ORDER.map((id) => byId(id)!);
}

function getMode(context: vscode.ExtensionContext): ModeDef {
  const stored = byId(context.globalState.get<string>(MODE_KEY, ''));
  const enabled = enabledModes();
  return stored && enabled.some((m) => m.id === stored.id) ? stored : enabled[0];
}

const isClaudeApi = (m: ModeDef) => m.envVar === 'ANTHROPIC_API_KEY';

/** Sync env collection + status bar to the given mode. Returns the mode actually in effect. */
async function apply(context: vscode.ExtensionContext, mode: ModeDef): Promise<ModeDef> {
  const env = context.environmentVariableCollection;
  // Remove everything we may have injected before, so only the active mode's vars remain.
  const managed = new Set<string>(['OPENAI_BASE_URL']);
  for (const p of Object.values(PROVIDERS)) {
    managed.add(p.keyVar);
    managed.add(p.configVar);
  }
  for (const m of allModes()) {
    Object.keys(m.env ?? {}).forEach((k) => managed.add(k));
  }
  managed.forEach((k) => env.delete(k));

  let key: string | undefined;
  if (mode.secret) {
    key = await context.secrets.get(mode.secret);
    if (!key) {
      // No key saved: fall back to a mode that needs nothing.
      mode = enabledModes().find((m) => !m.secret && !m.env) ?? byId('claude-max')!;
    }
  }
  for (const [k, v] of Object.entries(mode.env ?? {})) {
    env.replace(k, v);
  }
  if (mode.envVar && mode.secret && key) {
    env.replace(mode.envVar, key);
  }
  await context.globalState.update(MODE_KEY, mode.id);
  statusItem.text = `$(${mode.icon}) ${mode.label}`;
  statusItem.tooltip = `${mode.desc}. Click to switch.${isClaudeApi(mode) ? ' Remote Control is unavailable in this mode.' : ''}`;
  return mode;
}

/** Switch to a mode, prompting for its key first if needed, then notify. */
async function switchTo(context: vscode.ExtensionContext, target: ModeDef): Promise<void> {
  if (target.secret && !(await context.secrets.get(target.secret))) {
    if (!(await promptForKey(context, target))) {
      return;
    }
  }
  const result = await apply(context, target);
  if (result.id !== target.id) {
    return;
  }
  if (isClaudeApi(target)) {
    void vscode.window.showWarningMessage(
      `Switched to ${target.label}. Restart open terminals/sessions. While ANTHROPIC_API_KEY is set, Claude Code reports "Remote Control requires claude.ai subscription auth"; switch to a Claude account mode to use Remote Control.`,
    );
  } else if (target.secret || target.env) {
    void vscode.window.showInformationMessage(
      `Switched to ${target.label}. Please restart open terminals/sessions if needed.`,
    );
  } else {
    vscode.window.setStatusBarMessage(`Switched to ${target.label}.`, 4000);
  }
}

async function toggle(context: vscode.ExtensionContext): Promise<void> {
  const enabled = enabledModes();
  if (enabled.length < 2) {
    void vscode.window.showInformationMessage('Only one mode is enabled. Run "AI Usage: Choose Modes" to add more.');
    return;
  }
  const behavior = vscode.workspace.getConfiguration('aiUsageToggle').get<string>('clickBehavior', 'cycle');
  if (behavior === 'menu') {
    return pickMode(context);
  }
  const current = getMode(context);
  const i = enabled.findIndex((m) => m.id === current.id);
  await switchTo(context, enabled[(i + 1) % enabled.length]);
}

async function pickMode(context: vscode.ExtensionContext): Promise<void> {
  const current = getMode(context);
  const picked = await vscode.window.showQuickPick(
    enabledModes().map((m) => ({
      label: `$(${m.icon}) ${m.label}`,
      description: m.id === current.id ? 'active' : undefined,
      detail: m.desc,
      mode: m,
    })),
    { title: 'Switch mode' },
  );
  if (picked) {
    await switchTo(context, picked.mode);
  }
}

/** Multi-select which modes are enabled. Keeps existing order; new ones are appended. */
async function chooseModes(): Promise<void> {
  const enabled = enabledModes();
  const ids = new Set(enabled.map((m) => m.id));
  const picks = await vscode.window.showQuickPick(
    allModes().map((m) => ({ label: `$(${m.icon}) ${m.label}`, detail: m.desc, picked: ids.has(m.id), mode: m })),
    { title: 'Enabled modes (reorder in Settings: aiUsageToggle.order)', canPickMany: true },
  );
  if (!picks) {
    return;
  }
  if (!picks.length) {
    void vscode.window.showWarningMessage('Enable at least one mode.');
    return;
  }
  const chosen = new Set(picks.map((p) => p.mode.id));
  const next = [...enabled.map((m) => m.id).filter((id) => chosen.has(id)), ...allModes().map((m) => m.id).filter((id) => chosen.has(id) && !ids.has(id))];
  await vscode.workspace.getConfiguration('aiUsageToggle').update('order', next, vscode.ConfigurationTarget.Global);
}

/** Wizard: add a named account, API key, or local server profile and enable it. */
async function addProfile(context: vscode.ExtensionContext): Promise<void> {
  const prov = await vscode.window.showQuickPick(
    (Object.keys(PROVIDERS) as Provider[]).map((p) => ({ label: PROVIDERS[p].label, provider: p })),
    { title: 'Add profile: provider' },
  );
  if (!prov) {
    return;
  }
  const types = [
    { label: 'Account login', detail: 'Subscription login; give it its own config folder to keep a second account', type: 'account' as const },
    { label: 'API key', detail: 'A key stored in the OS credential vault', type: 'api' as const },
    ...(prov.provider === 'openai'
      ? [{ label: 'Local server', detail: 'OpenAI-compatible endpoint such as Ollama or LM Studio', type: 'local' as const }]
      : []),
  ];
  const type = await vscode.window.showQuickPick(types, { title: 'Add profile: type' });
  if (!type) {
    return;
  }
  const taken = new Set(allModes().map((m) => m.id));
  const name = (
    await vscode.window.showInputBox({
      title: 'Add profile: name',
      prompt: 'Shown in the status bar and lists, e.g. "Work Max" or "Personal key".',
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() ? 'Name is required' : taken.has(`p:${v.trim()}`) ? 'A profile with that name exists' : undefined),
    })
  )?.trim();
  if (!name) {
    return;
  }

  const profile: Profile = { name, provider: prov.provider, type: type.type };
  if (type.type === 'account') {
    const dir = await vscode.window.showInputBox({
      title: 'Config folder (optional)',
      prompt: `Leave empty to use the default login. For a second account, give a folder; it is set as ${PROVIDERS[prov.provider].configVar}.`,
      placeHolder: `C:\\Users\\you\\.${prov.provider}-work`,
      ignoreFocusOut: true,
    });
    if (dir === undefined) {
      return;
    }
    if (dir.trim()) {
      profile.configDir = dir.trim();
    }
  } else if (type.type === 'local') {
    const url = await vscode.window.showInputBox({
      title: 'Local server base URL',
      value: 'http://localhost:11434/v1',
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\//.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
    });
    if (!url) {
      return;
    }
    profile.baseUrl = url.trim();
  }

  const mode = profileToMode(profile)!;
  if (mode.secret && !(await promptForKey(context, mode))) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('aiUsageToggle');
  await cfg.update('profiles', [...getProfiles(), profile], vscode.ConfigurationTarget.Global);
  await cfg.update('order', [...enabledModes().map((m) => m.id), mode.id], vscode.ConfigurationTarget.Global);

  const actions = ['Switch to it'];
  if (profile.configDir) {
    actions.push('Open login terminal');
  }
  const choice = await vscode.window.showInformationMessage(`Added "${name}".`, ...actions);
  if (choice === 'Switch to it') {
    await switchTo(context, byId(mode.id) ?? mode);
  } else if (choice === 'Open login terminal') {
    const cli = prov.provider === 'claude' ? 'claude' : prov.provider === 'gemini' ? 'gemini' : 'codex';
    const term = vscode.window.createTerminal({ name: `Login: ${name}`, env: mode.env });
    term.show();
    term.sendText(cli);
  }
}

async function promptForKey(context: vscode.ExtensionContext, mode: ModeDef): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `${mode.label} key (${mode.envVar})`,
    prompt: 'Stored in the OS credential vault via VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'API key cannot be empty'),
  });
  const key = value?.trim();
  if (!key || !mode.secret) {
    return undefined;
  }
  await context.secrets.store(mode.secret, key);
  return key;
}

/** Ask which API mode a key command is for; skip the prompt when there is only one. */
async function pickKeyMode(placeHolder: string): Promise<ModeDef | undefined> {
  const keyed = allModes().filter((m) => m.secret);
  if (keyed.length === 1) {
    return keyed[0];
  }
  const picked = await vscode.window.showQuickPick(
    keyed.map((m) => ({ label: m.label, detail: m.envVar, mode: m })),
    { placeHolder },
  );
  return picked?.mode;
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const mode = await pickKeyMode('Set key for which profile?');
  if (!mode || !(await promptForKey(context, mode))) {
    return;
  }
  await apply(context, getMode(context)); // refresh injected value if that mode is active
  void vscode.window.showInformationMessage(`${mode.label} key saved.`);
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  const mode = await pickKeyMode('Clear key for which profile?');
  if (!mode?.secret) {
    return;
  }
  await context.secrets.delete(mode.secret);
  await apply(context, getMode(context)); // falls back to an account mode if the active key is gone
  void vscode.window.showInformationMessage(`${mode.label} key cleared.`);
}
