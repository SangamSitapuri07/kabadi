# Chalane aur sign-in karne ke commands

Do terminal chahiye. Ek API ke liye, ek web ke liye.

## 1. Pehli baar (ek hi baar)

```bash
cd /home/user/kabadi
npm install                 # dependencies
npm run build:shared        # @kabadi/shared ko build karna zaroori hai
cp .env.example .env        # local config
```

`prisma generate` is machine par nahi chalta (binary CDN block hai). Client pehle se
`apps/api/src/generated/prisma/` mein committed hai, isliye kuch karne ki zaroorat nahi.

## 2. API chalao (Terminal 1)

```bash
cd /home/user/kabadi
npm run dev:api
```

Chalu hone par: `Listening on http://0.0.0.0:4000/api/v1`.
Pehli baar chalane par seed khud ho jaata hai (`ensureSeeded`) — materials, 6 accounts,
storefronts aur ek sample listing ban jaati hai.

Check:

```bash
curl -s http://127.0.0.1:4000/api/v1/health
```

## 3. Web chalao (Terminal 2)

```bash
cd /home/user/kabadi
npm run dev:web
```

Kholo: **http://localhost:3000**

## 4. Sign in karne ke liye accounts

Ye seeded local accounts hain (`apps/api/prisma/seed.ts`). **UI par ye list ab nahi hai** —
test block hata diya gaya hai. Credentials yahan hain taaki aap manually type kar sakein.

| Role | Email | Password | Kahan pahunchenge |
|---|---|---|---|
| Customer | `customer@kabadiwala.local` | `KabadiPass123` | `/dashboard/customer` |
| Collector | `collector@kabadiwala.local` | `KabadiPass123` | `/dashboard/collector` |
| Area shop | `shop@kabadiwala.local` | `KabadiPass123` | `/dashboard/shop` |
| Wholesale mandi | `wholesale@kabadiwala.local` | `KabadiPass123` | `/dashboard/mandi` |
| Recycler | `recycler@kabadiwala.local` | `KabadiPass123` | `/dashboard/recycler` |
| Admin | `admin@kabadiwala.local` | `AdminPass123` | `/dashboard/admin` |

Phone se bhi login ho sakta hai (login `identifier` leta hai — phone ya email).

## 5. Dashboards dekhna

Har role se login karke dekhna — aur **khaas kar shop vs mandi** (wo alag tier hain)
aur **admin** (sabse alag panels). Ek account se doosre role ka URL kholna bhi try karein,
jaise customer se `/dashboard/admin` — "ye aapka dashboard nahi hai" screen aani chahiye.

Sign-in page ke static preview ke liye: `docs/screenshots/signin-preview.html` browser
mein khol lein (CSS inline hai, API ki zaroorat nahi).

## 6. Tests

```bash
cd /home/user/kabadi

npm test                                   # API: 30 tests
npm run test:web                           # Web: 5 component tests (jsdom)
npm run typecheck                          # shared + api + web + mobile

# Dono servers chalu hone par, poora role-by-role journey:
npm --workspace @kabadi/web run test:journey
```

## 7. Production build dekhna

```bash
npm run build          # shared + api + web
npm --workspace @kabadi/web run start
```

## Masle aur unke hal

| Lakshan | Wajah | Hal |
|---|---|---|
| Sign in par "could not be reached" | API band hai | Terminal 1 mein `npm run dev:api` |
| Har page 500 | `.env` missing | `cp .env.example .env` |
| `Cannot find module '@kabadi/shared'` | shared build nahi hui | `npm run build:shared` |
| Dashboard khaali | us role ke paas data nahi | seed ke saath `npm run dev:api` dobara chalayein |
| Login ke baad wapas sign-in par | cookie block | browser mein third-party cookie / cross-site block band karein (localhost par aam nahi) |

## Ek zaroori baat

Yahan se **Google login nahi hai**. Ye "chhoot gaya" nahi hai — code mein kahin OAuth
implementation hi nahi hai (`apps/api`, `apps/web`, `apps/mobile` — teeno mein search kiya).
Abhi jo hai wo phone/email + password (`POST /auth/register`, `POST /auth/login`),
OTP (/auth/otp/*) aur dev sign-in hai. Google OAuth naya kaam hai, uske liye
Google Cloud se client ID/secret chahiye honge.
