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
    // Split on CRLF as well as LF, and do not let a trailing \r reach a value.
    // A Notepad-saved .env is CRLF, and `.` does not match \r in JavaScript, so
    // a /(.*)$/ pattern matches nothing at all on every line of such a file --
    // silently, leaving the whole environment empty. That is how this failed on
    // the owner's Windows machine and worked everywhere else.
    const text = readFileSync(join(root, '.env'), 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      // Never override a value the real environment already set: an exported
      // variable, or a .env Next loaded itself, is more specific than this file.
      if (process.env[key] !== undefined) continue;
      // Quoted values are taken literally -- dots in a URL must survive -- and
      // anything after an unquoted '#' is a comment, so `KEY= # blank` is an
      // empty value rather than the text of the comment.
      const raw = match[2]!;
      let value: string;
      if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0]) {
        value = raw.slice(1, -1);
      } else {
        const hash = raw.indexOf('#');
        value = (hash === -1 ? raw : raw.slice(0, hash)).trim();
      }
      process.env[key] = value;
    }
  } catch { /* an unreadable .env is not worth failing a request over */ }
}
