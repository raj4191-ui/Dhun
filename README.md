# Dhun: music app + server

Zero dependencies. Needs Node 18 or newer.

```
cd dhun
npm start            # or: node server.js
# open http://localhost:3000
```

## What the server does
| Endpoint | Purpose |
|---|---|
| `GET /api/tracks?q=&lang=` | Search and filter the catalog |
| `GET /api/trending` | Top tracks by play count |
| `GET /api/recommendations?hour=` | Picks by time of day and the signed-in user's history |
| `POST /api/tracks/:id/play` | Counts a play |
| `POST /api/auth/otp`, `POST /api/auth/verify` | Phone OTP sign-in, returns a signed 30-day token |
| `GET/PUT /api/me/data` | Liked songs, playlists, downloads and history, synced per user |
| `POST /api/billing/demo` | Demo Premium switch (see below) |
| `GET /media/<file>` | Audio streaming with HTTP Range, so seeking works |

The server also inserts the catalog into the page, so the first screen loads without an extra request. If the server is unreachable, the app falls back to its built-in catalog.

## Add your own songs
1. Put licensed audio files (`.mp3 .m4a .ogg .wav .flac`) in `media/`.
2. In `tracks.json`, add `"file": "yourfile.mp3"` to a track. Tracks with no file (or a missing file) keep playing the built-in synth tune.
3. Edits to `tracks.json` show up on the next page load. No restart needed.

## Before you go live
- Set `NODE_ENV=production`. In dev mode the OTP is returned in the API response and printed in the console. In production you must set `SMS_WEBHOOK` to a URL that accepts `POST {"phone","message"}` (a small bridge to MSG91, Twilio, etc.).
- Set `SESSION_SECRET` to a long random string. Otherwise one is generated into `data/db.json`.
- Put it behind HTTPS (Nginx, Caddy or your host's proxy). Rate limiting uses the connecting IP, so behind a proxy adapt `limit()` to read `X-Forwarded-For` from your trusted proxy.
- Billing is a demo. `POST /api/billing/demo` lets any signed-in user switch Premium on. Set `DEMO_BILLING=0` to disable it, then add Razorpay or Stripe checkout and a payment webhook that sets `premium` on the user.
- Data lives in `data/db.json` (phone numbers included), fine for a prototype. Move to Postgres or SQLite with real traffic, and back it up.
- For scale, move `media/` to object storage behind a CDN and set each track's `file` to the CDN URL.
