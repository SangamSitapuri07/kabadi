import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The new workspace must not pick up the legacy repository's lockfile.
  turbopack: { root: resolve(webRoot, '../..') },
  allowedDevOrigins: ['*.e2b.app'],
  // OAuth callback URLs contain short-lived credentials; don't log auth requests.
  // Other infrastructure and libraries may still log URLs and need review.
  logging: { incomingRequests: { ignore: [/^\/api\/auth(?:\/|\?|$)/] } },
};

export default nextConfig;
