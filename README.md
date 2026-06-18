# Tracely

A minimal dashboard that receives and displays logs from any Roblox game over HTTP.
Hosted on **Vercel** (serverless functions) + **Turso** (hosted SQLite) — 100% free, no credit card required.

## Stack

- **Frontend**: Plain HTML + CSS + vanilla JS, served as Vercel static files
- **Backend**: Vercel serverless functions (`/api/log`, `/api/logs`, `/api/stats`)
- **Database**: Turso (hosted libSQL/SQLite, free tier — no card needed)

---

## 1. Set up Turso (free, no credit card)

1. Go to [turso.tech](https://turso.tech) and sign up (GitHub login works).
2. Install the Turso CLI:
   ```bash
   # macOS/Linux
   curl -sSfL https://get.tur.so/install.sh | bash

   # Windows (WSL)
   curl -sSfL https://get.tur.so/install.sh | bash
   ```
3. Log in:
   ```bash
   turso auth login
   ```
4. Create your database:
   ```bash
   turso db create tracely
   ```
5. Get your database URL:
   ```bash
   turso db show tracely --url
   ```
6. Create an auth token:
   ```bash
   turso db tokens create tracely
   ```
   Save both values — you'll need them in the next step.

---

## 2. Deploy to Vercel (free, no credit card)

1. Push this project to a GitHub repo (make sure `.env` is gitignored — it already is).
2. Go to [vercel.com](https://vercel.com) and import the repo.
3. Under **Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `TRACELY_KEY` | A long random secret (this is your dashboard password) |
   | `TURSO_DATABASE_URL` | The URL from `turso db show tracely --url` |
   | `TURSO_AUTH_TOKEN` | The token from `turso db tokens create tracely` |
4. Click **Deploy**. Vercel gives you a public URL instantly.

---

## 3. Sending logs from Roblox

In Roblox Studio, enable **HTTP Requests** under Game Settings → Security. Then from a server script:

```lua
local HttpService = game:GetService("HttpService")

local TRACELY_URL = "https://your-vercel-url.vercel.app/api/log"
local TRACELY_KEY = "the-same-key-you-set-in-vercel"

local function sendLog(level, message)
    local body = HttpService:JSONEncode({
        level = level,       -- "INFO" | "WARN" | "ERROR"
        message = message,
        timestamp = math.floor(os.time()),
        gameId = game.GameId,
        tracelyKey = TRACELY_KEY,
    })

    local ok, err = pcall(function()
        HttpService:PostAsync(TRACELY_URL, body, Enum.HttpContentType.ApplicationJson)
    end)

    if not ok then
        warn("Tracely log failed: " .. tostring(err))
    end
end

sendLog("INFO", "Player verification started")
```

---

## Local development

1. Install the [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
2. Create a `.env` file in the project root:
   ```
   TRACELY_KEY=your-secret-key
   TURSO_DATABASE_URL=libsql://your-db.turso.io
   TURSO_AUTH_TOKEN=your-token
   ```
3. Run locally:
   ```bash
   npm install
   vercel dev
   ```
4. Open `http://localhost:3000` and enter your `TRACELY_KEY`.

---

## Notes

- The dashboard password prompt is backed by real server-side auth — the key is sent as a header on every `/api/logs` and `/api/stats` request.
- A wrong or missing `tracelyKey` on `POST /api/log` returns 401 and the entry is dropped silently.
- The activity chart buckets logs by hour for the last 24 hours, stacked by level.
- Turso's free tier includes 500 databases, 9 GB storage, and 500M rows read/month — more than enough for a Roblox log monitor.
