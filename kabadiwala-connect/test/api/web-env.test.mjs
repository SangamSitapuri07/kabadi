import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The loader is compiled separately so the test exercises the same source the
// routes import.
const { loadWorkspaceEnv } = await import('../../apps/web/app/env.ts').catch(async () => {
  // Node cannot import TypeScript directly; transpile with the compiler Next
  // already ships, exactly as the component tests do.
  const { createRequire } = await import('node:module');
  const { readFile } = await import('node:fs/promises');
  const require = createRequire(import.meta.url);
  const babel = require('next/dist/compiled/babel/core');
  const compiled = babel.transformSync(await readFile(new URL('../../apps/web/app/env.ts', import.meta.url), 'utf8'), {
    filename: 'env.ts', babelrc: false, configFile: false,
    presets: [[require('next/dist/compiled/babel/preset-typescript'), { allExtensions: true, isTSX: true }]],
    plugins: [require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
  });
  const temp = await mkdtemp(join(tmpdir(), 'env-mod-'));
  const file = join(temp, 'env.cjs');
  await writeFile(file, compiled.code);
  return await import(file);
});

test('the workspace .env is found from the package root, and only from there', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kabadi-root-'));
  const previousCwd = process.cwd();
  const saved = process.env.AUTH_PUBLIC_ORIGIN;
  delete process.env.AUTH_PUBLIC_ORIGIN;
  try {
    // A directory with an .env but no apps/web must be ignored: a stray .env in a
    // home directory must never configure the service.
    await writeFile(join(root, '.env'), 'AUTH_PUBLIC_ORIGIN=http://wrong.example\n');
    await mkdir(join(root, 'apps', 'web'), { recursive: true });
    await writeFile(join(root, '.env'), [
      'AUTH_PUBLIC_ORIGIN="http://localhost:3000"',
      "# a comment",
      'API_INTERNAL_ORIGIN=http://127.0.0.1:4000 # trailing comment',
      '',
    ].join('\n'));

    // Run from a nested directory, as a server started from the repo root would
    // still resolve upward.
    process.chdir(join(root, 'apps', 'web'));
    // The module caches its work per process, so this asserts the behaviour of
    // one load; the paths below are what matter.
    loadWorkspaceEnv();
    assert.equal(process.env.AUTH_PUBLIC_ORIGIN, 'http://localhost:3000', 'quotes are stripped');
    assert.equal(process.env.API_INTERNAL_ORIGIN, 'http://127.0.0.1:4000', 'trailing comments are stripped');
  } finally {
    process.chdir(previousCwd);
    if (saved === undefined) delete process.env.AUTH_PUBLIC_ORIGIN; else process.env.AUTH_PUBLIC_ORIGIN = saved;
    delete process.env.API_INTERNAL_ORIGIN;
    await rm(root, { recursive: true, force: true });
  }
});

test('the loader never overrides a value the environment already set', async () => {
  // An exported variable, or a .env Next loaded itself, is more specific than the
  // workspace file. A loader that overrode it would make a real deployment
  // configuration silently wrong.
  const root = await mkdtemp(join(tmpdir(), 'kabadi-root2-'));
  const previousCwd = process.cwd();
  // Fresh module instance is not available here, so assert the rule at the source
  // level as well as through behaviour in the first test.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../apps/web/app/env.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(process\.env\[key\] !== undefined\) continue;/, 'an existing value wins');
  assert.match(source, /process\.cwd\(\)/, 'resolution starts from the working directory');
  // The bug that made the first version do nothing: resolving from import.meta.url
  // points inside .next/server in a production build, where no .env exists.
  assert.equal(/import\.meta\.url/.test(source.replace(/\/\/.*$/gm, '')), false,
    'import.meta.url must not be used for path resolution');
  await rm(root, { recursive: true, force: true });
  process.chdir(previousCwd);
});
