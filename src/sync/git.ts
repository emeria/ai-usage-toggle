import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { normPath } from './util';

export interface GitCheck {
  dirExists: boolean;
  isRepo: boolean;
  branch?: string;
  dirty: boolean;
  /** True when no branch is expected or the current branch matches it. */
  branchMatches: boolean;
  /** Another worktree that has the expected branch checked out. */
  worktreeForBranch?: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export function checkTarget(dir: string, expectedBranch?: string): GitCheck {
  if (!fs.existsSync(dir)) {
    return { dirExists: false, isRepo: false, dirty: false, branchMatches: false };
  }
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === undefined) {
    return { dirExists: true, isRepo: false, dirty: false, branchMatches: true };
  }
  const dirty = (git(dir, ['status', '--porcelain']) ?? '') !== '';
  const branchMatches = !expectedBranch || expectedBranch === 'HEAD' || branch === expectedBranch;
  let worktreeForBranch: string | undefined;
  if (!branchMatches) {
    let wt: string | undefined;
    for (const line of (git(dir, ['worktree', 'list', '--porcelain']) ?? '').split('\n')) {
      if (line.startsWith('worktree ')) {
        wt = line.slice(9);
      } else if (line === `branch refs/heads/${expectedBranch}` && wt && normPath(wt) !== normPath(dir)) {
        worktreeForBranch = wt;
      }
    }
  }
  return { dirExists: true, isRepo: true, branch, dirty, branchMatches, worktreeForBranch };
}
