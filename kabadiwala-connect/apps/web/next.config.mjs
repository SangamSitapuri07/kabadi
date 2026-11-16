import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The new workspace must not pick up the legacy repository's lockfile.
  turbopack: { root: resolve(webRoot, '../..') },
  allowedDevOrigins: ['*.e2b.app'],
};

export default nextConfig;
