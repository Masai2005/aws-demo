# Likes app

A tiny posts app with likes and comments. TypeScript everywhere, React UI, Bun server, SQLite (`bun:sqlite`).

```bash
bun install
bun run dev        # http://localhost:3456
bun test           # endpoint tests
bun run typecheck
```

Demo account: **demo / demo1234** (or click "Use the demo account" on the login page).
Data lives in `data.sqlite`; delete it to reset to the seed data.

## The 10 endpoints

| # | Method | Path | What it does |
|---|--------|------|--------------|
| 1 | POST | `/api/login` | Log in (`{ username, password }`), sets an http-only session cookie |
| 2 | POST | `/api/logout` | End the session |
| 3 | GET | `/api/me` | The logged-in user |
| 4 | GET | `/api/posts` | All posts, newest first, with like and comment counts |
| 5 | POST | `/api/posts` | Create a post (`{ body }`, 1–500 chars) |
| 6 | DELETE | `/api/posts/:id` | Delete your own post (and its likes and comments) |
| 7 | POST | `/api/posts/:id/like` | Like or unlike (toggle); returns the updated post |
| 8 | GET | `/api/posts/:id/comments` | A post's comments, oldest first |
| 9 | POST | `/api/posts/:id/comments` | Add a comment (`{ body }`) |
| 10 | DELETE | `/api/comments/:id` | Delete your own comment |

Everything except login needs the session cookie. Errors come back as `{ "error": "..." }`.

## Files

- `src/server.ts` – starts Bun, serves the React page and the API
- `src/api.ts` – the 10 endpoints
- `src/db.ts` – tables and seed data
- `src/shared/types.ts` – types used by both server and client
- `src/client/` – React app (`App.tsx`, `api.ts`, `styles.css`)
