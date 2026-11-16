// Fixed HTML avoids reflecting even direct requests' query strings in Next's
// server-rendered page payload. No input is read or inserted into the response.
export const dynamic = 'force-dynamic';

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign-in unavailable | Kabadiwala Connect</title>
  <style>
    :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; background: #f8faf5; color: #18362c; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { min-height: 100vh; padding: 32px clamp(24px, 7vw, 112px); display: flex; flex-direction: column; }
    .brand { font-weight: 700; } .brand span { color: #21815b; font-size: 1.4rem; margin-right: 6px; }
    section { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; max-width: 760px; padding: 80px 0; }
    .eyebrow { font-size: .7rem; font-weight: 700; letter-spacing: .16em; color: #358263; }
    h1 { font-size: clamp(3rem, 7vw, 5.8rem); line-height: 1.04; letter-spacing: -.06em; margin: 20px 0; }
    h1 span { color: #31825d; }
    .description { color: #536a5e; font-size: clamp(1rem, 2vw, 1.2rem); line-height: 1.7; max-width: 520px; }
    a { display: inline-block; margin-top: 24px; border: 1px solid #cfded1; background: white; border-radius: 10px; color: #18362c; padding: 13px 20px; font-weight: 700; text-decoration: none; }
    a:focus-visible { outline: 3px solid #21815b; outline-offset: 3px; }
    .note { font-size: .8rem; color: #536a5e; max-width: 420px; line-height: 1.5; }
  </style>
</head>
<body><main>
  <div class="brand"><span aria-hidden="true">♻</span> Kabadiwala Connect</div>
  <section aria-labelledby="sign-in-error">
    <p class="eyebrow">SIGN-IN</p>
    <h1 id="sign-in-error">We could not complete <span>sign-in.</span></h1>
    <p class="description">Please return to the home page and start a new Google sign-in attempt. If the problem continues, try again later.</p>
    <a href="/">Return to sign-in</a>
    <p class="note">Development only. Sign-in and security are not ready for production.</p>
  </section>
</main></body>
</html>`;

export function GET(): Response {
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  } });
}
