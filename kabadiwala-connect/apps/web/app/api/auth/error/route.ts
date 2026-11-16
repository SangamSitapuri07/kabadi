// Better Auth can redirect here with provider-supplied error details. Discard
// the entire query rather than reflecting it into HTML, logs, or the next URL.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/auth/error',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
