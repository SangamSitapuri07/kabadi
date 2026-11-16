// This is deliberately a liveness-only bridge, not a general-purpose API proxy.
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };
const unavailable = () => Response.json(
  { error: { code: 'API_UNAVAILABLE', message: 'API liveness is unavailable.' } },
  { status: 503, headers },
);

export async function GET() {
  try {
    // Server-side configuration only; never derive an upstream from the request.
    const origin = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) return unavailable();

    const response = await fetch(new URL('/api/v1/health/live', origin), {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return unavailable();
    const result: unknown = await response.json();
    if (typeof result !== 'object' || result === null || !('data' in result) ||
        typeof result.data !== 'object' || result.data === null ||
        !('status' in result.data) || result.data.status !== 'alive' ||
        !('service' in result.data) || result.data.service !== 'api') return unavailable();

    // Do not relay unexpected fields or upstream headers.
    return Response.json({ data: { status: 'alive', service: 'api' } }, { headers });
  } catch {
    return unavailable();
  }
}
