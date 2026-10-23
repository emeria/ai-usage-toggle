import fs from 'node:fs';

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function readJsonl(file: string): any[] {
  const out: any[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a torn or partial line
    }
  }
  return out;
}

export function newestFirst(files: string[]): string[] {
  return files
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((x) => x.f);
}

/** Normalize a path for comparing across drive-letter case and slash style. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function editNote(name: string, input: any): string | undefined {
  const file = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (/^(edit|write|multiedit|notebookedit|write_file|replace|edit_file)$/i.test(name) && file) {
    return `edited ${file}`;
  }
  const cmd = input?.command;
  if (/^(bash|run_shell_command|shell)$/i.test(name) && typeof cmd === 'string') {
    return `ran: ${truncate(cmd, 120)}`;
  }
  return undefined;
}
