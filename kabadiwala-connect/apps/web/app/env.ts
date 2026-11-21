// THIS FILE MUST NOT USE import.meta.url.
//
// The service keeps one .env at the workspace root, but Next only loads env files
// from its project directory -- and `next start apps/web` makes that directory
// apps/web, so the root .env was never read. Every web route then saw an empty
// AUTH_PUBLIC_ORIGIN and answered 503, which looks exactly like a broken API.
//
// The obvious fix, resolving from import.meta.url, silently does nothing in a
// production build: Next rewrites the module URL to 'apps/web/app/env.ts'
// relative to .next/server/, so every candidate path lands inside the build
// output and no file is found. That was verified by printing the resolved paths,
// not assumed. Resolution therefore walks up from the process's working
// directory, which for this repository's own start commands is the package root.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

let loaded = false;

// A directory is the workspace root when it holds both the shared .env and the
// apps/web project. Requiring both means a stray .env in an unrelated parent
// (a home directory, for instance) cannot be picked up by accident.
function workspaceRoot(start: string): string | null {
  let current = start;
  for (;;) {
    if (existsSync(join(current, '.env')) && existsSync(join(current, 'apps', 'web'))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return null;
    current = parent;
  }
}

export function loadWorkspaceEnv(): void {
  if (loaded) return;
  loaded = true;
  const root = workspaceRoot(process.cwd());
  if (!root) return;
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      // Never override a value the real environment already set: an exported
      // variable, or a .env Next loaded itself, is more specific than this file.
      if (process.env[key] !== undefined) continue;
      let value = match[2]!.trim();
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
        value = value.slice(1, -1);
      } else {
        const hash = value.indexOf(' #');
        if (hash !== -1) value = value.slice(0, hash).trimEnd();
      }
      process.env[key] = value;
    }
  } catch { /* an unreadable .env is not worth failing a request over */ }
}
