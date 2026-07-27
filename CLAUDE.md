# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Manufacturing Execution System (MES) for "Confecciones Millar" — a garment manufacturing company. Monolithic Node.js/Express server with self-contained HTML front-end screens (no build step, no framework), one folder per module. Deployed via GitHub → Render (paid plan with persistent disk).

## Commands

```bash
npm start          # Production: node server.js (PORT defaults to 3000)
npm run dev         # Development: nodemon server.js (auto-reload on changes)
```

No test suite, no linter, no build step for the main app. The punto-seguro sub-app has its own build (`punto-seguro/client/` — Vite SPA served from `punto-seguro/client/dist/`).

## Architecture

### Server (`server.js` — ~3180 lines, single file)

The entire backend lives in one file. Key sections in order:

1. **WhatsApp integration** (Baileys) — starts ~line 38
2. **Environment & config** — `PORT`, `RESET_PASS`, `SESSION_SECRET`, `AUTH_ENFORCE`, `DATA_DIR` — ~lines 130–170
3. **Data file paths** (`FILES` object) — starts ~line 174
4. **SQLite layer** — ~lines 174–345 (see critical rule below); `SQLITE_ON` flag at ~line 257
5. **Auth system** (bcrypt, `PROGRAMADOR_PROFILE` superuser at ~line 349, HMAC tokens, users.json)
6. **Express middleware** (input sanitization ~line 787, auth guard ~line 813, rate limiter ~line 830)
7. **Static routes for each module** (`app.get('/<modulo>', ...)` serving `modulos/<carpeta>/<archivo>.html`) and `express.static` for `compartido/` — ~lines 900–970
8. **REST API routes** (`/api/*`) — ~lines 970–2670
9. **WebSocket server** — starts ~line 2673 (real-time floor updates, module state)

### Front-end (`modulos/`, one subfolder per module, no shared framework)

Each HTML file is a self-contained SPA with inline CSS/JS. No shared template engine — navigation is duplicated per file. The token interceptor in `index.html` auto-attaches `Authorization: Bearer` to all fetch/WebSocket calls.

- `modulos/index/index.html` (~9500 lines) — Main dashboard, admin panels, user management, Control de Asistencia's local cache, and the (unused-but-still-present) legacy Tablero engine code kept for now because Control de Asistencia and Tablero_CI's WebSocket handlers still touch its shared state
- `modulos/produccion/produccion.html` — Production floor control
- `modulos/tablero-ci/Tablero_CI.html` — CI dashboard
- `modulos/tablero/tablero.html` — Tablero General / Tablero Mecánicos (full clone of index.html; reuses index.html's `?tablero=general|mecanicos` auto-login mechanism, entered via `/tablero`)
- `modulos/ingresos/ingresos.html` — Control de Asistencia / income tracking
- `modulos/ordenes/`, `modulos/solicitar-insumos/`, `modulos/hoja-vida-maquina/`, `modulos/contador-modulos/`, `modulos/recogedores/`, `modulos/revision-telas/`, `modulos/incentivos/`, `modulos/registro-mecanicos/`, `modulos/corte/` — Specialized modules
- `modulos/control-permisos/`, `modulos/control-visitantes-sst/` — Kiosk-mode screens (no auth token)
- `modulos/mantenimiento.html` — **not yet wired up** (no server route, no nav entry); pending integration

### Shared assets (`compartido/`)

- `logo.png.jpeg` — served at `/logo.png` via a candidate-path lookup in server.js
- `seed-plantillas.js` — standalone CLI seeder script, not HTTP-served
- Served generically via `express.static(path.join(__dirname, 'compartido'))`

### Sub-app: Punto Seguro (`punto-seguro/`)

Occupational safety training module. Separate Vite+vanilla-JS SPA in `punto-seguro/client/`, API in `ps-api.js` (Express Router mounted at `/punto-seguro/api`). Has its own `ps-data/` directory and does NOT use the main SQLite layer — uses direct `fs` read/write via its own `psRead`/`psWrite` helpers.

## Critical: SQLite persistence rule

**Production uses `STORAGE=sqlite`.** All data read/write MUST go through:
- `readJSON(filePath, defaultValue)` — reads from SQLite when active, falls back to file
- `writeJSON(filePath, data)` — async write, routes to SQLite when active
- `writeJSONSync(filePath, data)` — sync write, routes to SQLite when active

**NEVER use `fs.writeFileSync`, `fs.existsSync` (for data checks), or `fs.promises.writeFile` directly for data files.** With SQLite active, those operations write to the filesystem while reads come from SQLite — the data "disappears."

The `SQLITE_ON` flag (~line 257) indicates whether SQLite is active at runtime.

## Auth system

- Passwords: bcrypt-hashed, stored in `users.json` (via SQLite in production)
- Tokens: HMAC-signed (`SESSION_SECRET`), stored client-side in `localStorage` as `cm_session`
- `AUTH_ENFORCE` (env var): when `false` (current default), API routes are open; when `true`, `/api/*` requires valid token
- The auth guard (~line 813) does NOT cover `/punto-seguro/api/*`
- `PROGRAMADOR_PROFILE` (~line 349): superuser with `pass: '1'` as initial default — change immediately in production
- Several modules (e.g. `revision_telas.html`) have their own lightweight login screen with their own member list + plain password, independent of `cm_session` — this is the established pattern for module-local auth in this codebase, not a bug

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
