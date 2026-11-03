#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [action, repository, receipt] = process.argv.slice(2);
if (!['capture', 'check'].includes(action) || !repository || !receipt) {
  throw new Error('Usage: node scripts/verify-protected-worktree.mjs capture|check REPOSITORY RECEIPT');
}
const root = resolve(repository);
const destination = resolve(receipt);
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const names = (value) => value.split('\0').filter(Boolean);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const index = () => new Map(names(git('ls-files', '--stage', '-z')).map((entry) => {
  const at = entry.indexOf('\t');
  return [entry.slice(at + 1), entry.slice(0, at)];
}));
async function fingerprint(path) {
  try {
    const info = await lstat(resolve(root, path));
    if (info.isSymbolicLink()) return { kind: 'symlink', sha256: digest(await readlink(resolve(root, path))) };
    if (info.isFile()) return { kind: 'file', mode: info.mode & 0o777, sha256: digest(await readFile(resolve(root, path))) };
    return { kind: 'other', mode: info.mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}
if (action === 'capture') {
  const staged = names(git('diff', '--cached', '--name-only', '-z'));
  const unstaged = names(git('diff', '--name-only', '-z'));
  const entries = index();
  const files = [];
  for (const path of [...new Set([...staged, ...unstaged])].sort()) {
    files.push({ path, staged: staged.includes(path), index: entries.get(path) ?? null, worktree: await fingerprint(path) });
  }
  const baseline = { schema: 'protected-worktree/v1', repository: root, head: git('rev-parse', 'HEAD').trim(), capturedAt: new Date().toISOString(), files };
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ action, repository: root, receipt: destination, staged: staged.length, unstaged: unstaged.length, protected: files.length }));
} else {
  const baseline = JSON.parse(await readFile(destination, 'utf8'));
  if (baseline.schema !== 'protected-worktree/v1' || baseline.repository !== root || !Array.isArray(baseline.files)) throw new Error('Receipt does not belong to this repository.');
  const entries = index();
  const differences = [];
  for (const file of baseline.files) {
    if ((entries.get(file.path) ?? null) !== file.index) differences.push({ path: file.path, changed: 'index' });
    if (JSON.stringify(await fingerprint(file.path)) !== JSON.stringify(file.worktree)) differences.push({ path: file.path, changed: 'worktree' });
  }
  console.log(JSON.stringify({ action, repository: root, protected: baseline.files.length, preserved: differences.length === 0, differences }));
  if (differences.length > 0) process.exitCode = 1;
}
