# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Manufacturing Execution System (MES) for "Confecciones Millar" — a garment manufacturing company. Monolithic Node.js/Express server with 14 self-contained HTML front-end screens (no build step, no framework). Deployed via GitHub → Render (paid plan with persistent disk).

## Commands

```bash
npm start          # Production: node server.js (PORT defaults to 3000)
npm run dev         # Development: nodemon server.js (auto-reload on changes)
```

No test suite, no linter, no build step for the main app. The punto-seguro sub-app has its own build (`punto-seguro/client/` — Vite SPA served from `punto-seguro/client/dist/`).

## Architecture

### Server (`server.js` — ~2870 lines, single file)

The entire backend lives in one file. Key sections in order:

1. **WhatsApp integration** (Baileys) — lines 34–127
2. **Environment & config** — `PORT`, `RESET_PASS`, `SESSION_SECRET`, `AUTH_ENFORCE`, `DATA_DIR` — lines 130–170
3. **Data file paths** (`FILES` object) — lines 174–202
4. **SQLite layer** — lines 204–296 (see critical rule below)
5. **In-memory cache** (`loadDB`/`saveDB`) — lines 298–324
6. **Auth system** (bcrypt, HMAC tokens, users.json) — lines 540–660, 1882–1990
7. **Express middleware** (sanitization, auth guard, rate limiter) — lines 740–820
8. **REST API routes** — lines 830–2370
9. **WebSocket server** — lines 2375–2853 (real-time floor updates, module state)

### Front-end (14 HTML files, no shared framework)

Each HTML file is a self-contained SPA with inline CSS/JS. No shared template engine — navigation (`buildNav`) is duplicated per file. The token interceptor in `index.html` (lines 31–33) auto-attaches `Authorization: Bearer` to all fetch/WebSocket calls.

- `index.html` (~9460 lines) — Main dashboard, admin panels, user management
- `produccion.html` — Production floor control
- `Tablero_CI.html` — CI dashboard
- `ingresos.html` — Income tracking
- `ordenes.html`, `solicitar_insumos.html`, `hoja_vida_maquina.html`, `contador_modulos.html`, `recogedores.html`, `revision_telas.html`, `incentivos.html`, `registro-mecanicos.html` — Specialized modules
- `control_permisos.html`, `control-visitantes-sst.html` — Kiosk-mode screens (no auth token)

### Shared assets

- `user-menu.js` — User menu (profile + logout) loaded in all pages except index.html (which has its own integrated version). Self-contained IIFE, auto-mounts on DOMContentLoaded, CSS prefixed `cmum-`.
- `millar-shared.css` — Shared stylesheet
- `seed-plantillas.js` — Template seeder script

### Sub-app: Punto Seguro (`punto-seguro/`)

Occupational safety training module. Separate Vite+vanilla-JS SPA in `punto-seguro/client/`, API in `ps-api.js` (Express Router mounted at `/punto-seguro/api`). Has its own `ps-data/` directory and does NOT use the main SQLite layer — uses direct `fs` read/write via its own `psRead`/`psWrite` helpers.

## Critical: SQLite persistence rule

**Production uses `STORAGE=sqlite`.** All data read/write MUST go through:
- `readJSON(filePath, defaultValue)` — reads from SQLite when active, falls back to file
- `writeJSON(filePath, data)` — async write, routes to SQLite when active
- `writeJSONSync(filePath, data)` — sync write, routes to SQLite when active

**NEVER use `fs.writeFileSync`, `fs.existsSync` (for data checks), or `fs.promises.writeFile` directly for data files.** With SQLite active, those operations write to the filesystem while reads come from SQLite — the data "disappears."

The `SQLITE_ON` flag (line 254) indicates whether SQLite is active at runtime.

## Auth system

- Passwords: bcrypt-hashed, stored in `users.json` (via SQLite in production)
- Tokens: HMAC-signed (`SESSION_SECRET`), stored client-side in `localStorage` as `cm_session`
- `AUTH_ENFORCE` (env var): when `false` (current default), API routes are open; when `true`, `/api/*` requires valid token
- The auth guard at line 785 does NOT cover `/punto-seguro/api/*`
- `PROGRAMADOR_PROFILE` (line 327): superuser with `pass: '1'` as initial default — change immediately in production

## Environment variables (Render)

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (3000) | Server port |
| `STORAGE` | Yes (`sqlite`) | Set to `sqlite` for production |
| `DATA_DIR` | No (auto-detects `/var/data`) | Persistent disk path |
| `SESSION_SECRET` | Recommended | HMAC signing key (random per restart if missing) |
| `RESET_PASS` | Recommended | Password for `/admin/reset` endpoint |
| `AUTH_ENFORCE` | No (`false`) | Enable token-based auth enforcement |
| `ALLOWED_ORIGIN` | No (open) | CORS restriction |

## Deployment

Push to `main` branch → Render auto-deploys. If deploy fails, Render keeps the previous working version. Start command: `node server.js`. Persistent disk mounted at `/var/data`.
