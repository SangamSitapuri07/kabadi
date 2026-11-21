# Dashboard previews without a browser

This sandbox cannot download a browser (Playwright's CDN is blocked), so there are no
PNG screenshots here. Instead these files are the **real server HTML with the real compiled
Tailwind CSS inlined**, so opening one in any browser shows the actual layout, spacing and
typography.

They are **not** live pages: React never hydrates, so nothing is clickable and any panel that
loads data after mount shows its loading state. The sign-in page is fully static, so it is
pixel-accurate. The dashboards are not — to see those properly, open the live preview and sign
in.

## How they were made

```bash
# 1. the compiled stylesheet, produced by `npm run build` in apps/web
CSS=$(ls -S apps/web/.next/static/css/*.css | head -1)

# 2. the server HTML for a page
curl -s http://127.0.0.1:3000/ -o /tmp/signin.html

# 3. inline the CSS so the file stands alone
python3 - <<'PY'
import re, pathlib
css = pathlib.Path("apps/web/.next/static/css/<hash>.css").read_text()
html = pathlib.Path("/tmp/signin.html").read_text()
html = re.sub(r'<link[^>]+\.css[^>]*>', '', html)
html = html.replace('</head>', f'<style>{css}</style></head>', 1)
pathlib.Path("/tmp/signin_preview.html").write_text(html)
PY
```

Regenerate these whenever the styles change; they are a snapshot, not a build artifact.
