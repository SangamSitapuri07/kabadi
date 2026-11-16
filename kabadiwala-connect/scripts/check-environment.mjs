import { pathToFileURL } from 'node:url';

// This is a baseline requirement for the foundation only. Framework versions
// must be checked separately before they are selected.
export function supportsNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match !== null && Number(match[1]) >= 22;
}

export function checkEnvironment(version = process.versions.node) {
  if (!supportsNode(version)) {
    return { ok: false, message: `Node.js 22 or newer is required; found ${version}.` };
  }
  return { ok: true, message: `Node.js ${version} meets the foundation requirement.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkEnvironment();
  console[result.ok ? 'log' : 'error'](result.message);
  if (!result.ok) process.exitCode = 1;
}
