# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Manufacturing Execution System (MES) for **Confecciones Millar**, a garment factory. Monolithic Node/Express server plus self-contained HTML screens — no framework, no build step (with one exception, below), one folder per module.

The user is **not a programmer**. Explain in plain Spanish, avoid jargon, and confirm before changing things. The user does all commits and pushes; report what changed and suggest the message.

## Commands

```bash
npm start        # node server.js — port 3000 by default
npm run dev      # nodemon server.js
```

`npm test` runs the small suite in `pruebas/` (node:test, no dependencies; today it covers `limitador.js`). No linter. Two local test servers exist (both gitignored):

- `node dev-local.js` — port 3010, data in `data-prueba/`, auth OFF
- `node prueba-auth.js` — port 3011, same data, **auth ON** (mirrors production)

Use the auth one for anything touching login, tokens, or screens that load data — production runs with `AUTH_ENFORCE=true` and a screen that works without a token locally can come up empty in production.

**Punto Seguro is the one part with a build step.** Changing `modulos/punto-seguro/client/src/` does nothing until you run its build and commit `modulos/punto-seguro/client/dist/` — the server serves `dist/`.

## Architecture

### Server (`server.js`, ~5100 lines, single file)

In order: MQTT (pick-to-light) → env/config → **date helpers** (~line 99) → file paths → SQLite layer (~171–305) → auth and person accounts (`accesos`, `cuentaDeCedula`, `permisosDeLaPeticion`) → middleware: XSS sanitising, auth guard (~784), rate limiter (~817) → screen routes (~865–985) → REST API (~987–4500) → WebSocket server (~4538).

### Screens (`modulos/<name>/<name>.html`)

Each file is a whole screen: markup, styles and code inline. There is no shared template — the nav bar is repeated in each file. Every screen carries a `millar-auth` block that attaches the session token to `fetch` and WebSocket calls.

Every screen also carries `<link rel="icon" type="image/png" href="/favicon.png?v=2">` right after its `<title>`, so the browser tab shows the Millar logo. **A new screen must include it too** (asked for on 22/09/2026). `/favicon.png` and `/favicon.ico` are served from `compartido/favicon.png` (64 px, 4 KB). Chrome caches favicons per page and ignores reloads, so **bump the `?v=` when the icon changes** — that is the only thing that forces it. `/logo.png` stays as the big one (`compartido/logo.png.jpeg`, 1280 px) for headers and login screens.

Routes: `/`, `/ingresos`, `/produccion`, `/ordenes`, `/tablero`, `/ci`, `/contador-produccion`, `/contador-produccion/admin`, `/configuracion-produccion`, `/contador-modulos`, `/registros-produccion`, `/tiempos-improductivos`, `/reporte-calidad`, `/incentivos`, `/registro-mecanicos` (alias `/alistamiento`), `/mantenimiento`, `/solicitar-insumos`, `/revision-telas`, `/recogedores`, `/hoja-vida`, `/corte`, `/ubicaciones`, `/permisos`, `/visitantes`, `/punto-seguro`.

Worth knowing:

- `modulos/index/index.html` (~9700 lines) — dashboard, admin panels, user management, and dead legacy Tablero code that Control de Asistencia and Tablero CI still touch through shared state.
- `/tablero` serves `modulos/index/index.html` (the old separate `tablero.html` copy was removed on 18/09/2026). Board-only behavior is gated by the `en-tablero` class on <html>, set in `entrarTablero()`.
- The three query screens (`registros-produccion`, `tiempos-improductivos`, `reporte-calidad`) share `modulos/registros/registros.html`; the route picks the columns.
- `modulos/control-permisos/` and `modulos/control-visitantes-sst/` are kiosk screens with no session token.
- Some modules (e.g. `revision_telas.html`, `ingresos.html`) have their own small login with a member list, independent of `cm_session`. Member passwords never reach the browser: `GET /api/app-config` strips them (`tieneClave` instead) and `POST /api/miembros/verificar` checks them. Action passwords (delete/edit/forced close) are checked by `POST /api/verificar-clave-accion` via `compartido/millar-clave.js`; never compare a password in the browser.

### Punto Seguro (`modulos/punto-seguro/`)

SST induction module. Vite SPA in `client/`, API in `ps-api.js` (router mounted at `/punto-seguro/api`, behind the main auth guard). It does **not** use the SQLite layer — it reads and writes JSON files with its own `psRead`/`psWrite`.

**Authorization (decided in the server, never only in the screen).** `server.js` mounts the router behind `requirePermiso('punto_seguro')`. Inside, worker routes (look yourself up by cedula, register, see the package, sign, take the quiz) need only that; everything else uses `soloAdmin` in `ps-api.js`. A request is admin if the person is an MES admin or typed the Punto Seguro admin password (signed `ps_admin` HttpOnly cookie, 2 h, bound to the session user; `ps-autorizacion.js`). The admin password has **no default**: it lives as a bcrypt hash in `ps_config.json` (an old plaintext one is converted on first correct use); if none exists, an MES admin creates it by typing the one they want at the Administrador login. Changing it needs the current one. Tests: `pruebas/punto-seguro.test.js`.

### Estado Mecánicos (`modulos/estado-mecanicos/`, route `/estado-mecanicos`, permission `estado_mecanicos`)

A live board with one card per mechanic: **Disponible** (green), **Atendiendo** (red: module, operator, running timer) or **Alistamiento** (garnet). Kiosk screen (`completa:true` in `RUTAS_MODULO`), polls `GET /api/estado-mecanicos` every 5 s and ticks the timers locally against the server clock. The logic is `estado-mecanicos.js` (pure, tested in `pruebas/estado-mecanicos.test.js`): it turns what the server already knows about modules upside down — `multiImps[module]` entries of type `yellow` (attention, with `mecanico`, `empleada` and `inicio` = when the mechanic arrived) or `garnet`/`pink` (alistamiento). A module waiting for a mechanic (`red`) occupies nobody. If a mechanic has several, the oldest attention is shown with "+N más". Cards are alphabetical (they do not jump around). The mechanics are the active members of the **Mecánicos profile** (`app_config._perfil_members.Mecanicos`) — they are NOT in the employee list.

Photos: Configuraciones → Perfiles → Mecánicos → ✏️ has a photo field (an editor in the browser — drag, zoom bar/±/wheel/pinch, Centrar, same rounded-square frame as the card — crops what is seen to a 320 px square JPEG and sends it to `POST /api/mecanicos/foto`, admins only, JPEG header checked, ≤ 400 KB). The file name (`mec-<time>-<id>.jpg`) is kept in the member's `foto`; `conservarClavesMiembros` keeps it when a stale screen saves the list without it (to remove a photo the screen sends `foto:''`). The image is served by `/api/archivos/:nombre` with permission `estado_mecanicos` or `configuraciones` and only while a member references it. No photo → initials.

## Rules that prevent real damage

These come from bugs that actually hit production. Each one cost data or downtime.

### 1. Data goes through the SQLite layer

Production runs `STORAGE=sqlite`. All data access must use `readJSON` / `writeJSON` / `writeJSONSync`, or `loadDB` / `saveDB`.

Never call `fs.writeFileSync`, `fs.existsSync` (for data) or `fs.promises.writeFile` on a data file. With SQLite on, those write to disk while reads come from SQLite — the data appears to vanish.

`loadDB` caches per key and never re-reads. Anything that mutates a cached key outside `saveDB` must refresh `dbCache[key]` too, or readers keep seeing the value from server start. (This is what froze the production target when attendance changed mid-shift.)

### 2. Dates: use `fechaHoyCO()`, never `toISOString()`

`toISOString()` returns the **London** date. After 7 p.m. Colombia time it rolls to the next day: the night shift found an empty operator list and records were stamped with tomorrow's date.

Use `fechaHoyCO()` for today and `fechaCO(d)` for a given date. Both live in `server.js` and, for screens, in `compartido/millar-fecha.js` (load it with `<script src="/millar-fecha.js"></script>`).

### 3. Panel screens send the whole list; the server replaces it

Admin panels POST complete arrays and the server overwrites. A screen that failed to load its data would send an empty list and wipe everything. Four protections exist — do not remove any of them:

- `puedeGuardar()` blocks saving until the data actually loaded
- `avisoBorradoMasivo()` returns 409 when 3 or more entries disappear at once (bypass with `?confirmar=1`)
- `recuperarPerfilesFaltantes()` rebuilds profiles from `users.json` at startup
- boot retries plus a red banner when a load fails

### 4. Data is only requested once there is a session

`AUTH_ENFORCE=true`, so the API rejects everything without a token. The main screen requests its data **after** login (or on open when a session already exists), never before. Asking earlier produced a false alarm on new tablets and, worse, left the app running with no configuration.

Note that supervisors log in with no password and therefore **no token** — they currently run without server data. Deciding how they should authenticate is still open.

### 5. Punto Seguro writes to the persistent disk only

The deploy runs `git reset --hard`, so anything tracked by git is restored on every deploy. Punto Seguro's live data lives under `DATA_DIR`; the five SST forms that ship with the project sit in `modulos/punto-seguro/documentos-base/`, which the app **only reads**. Never point a write path back into the repository.

## Auth

- Passwords: bcrypt, in `users.json` (field is `passHash`), via SQLite in production
- Tokens: HMAC-signed with `SESSION_SECRET`, kept in `localStorage` as `cm_session`
- Public routes: `/api/login`, `/api/entrar`, `/api/me`, `/api/perfiles`, `/health`. Everything else, Punto Seguro included, needs a token
- `/api/perfiles` deliberately returns names only — no permissions, no passwords — so the login screen can list profiles before anyone signs in
- Read permissions: `permisos-get.js` holds ONE table `route → permissions` (admins always pass) behind one filter; routes not in the table are open to any session on purpose (catalogs the home screen asks for). It starts in `observar` mode. Before switching to `aplicar`, read the log (`grep PERMISOS-GET` in the PM2 out log) and fix the table. Pending decisions are in `deploy/permisos-get-propuesta.md`. Tests: `pruebas/permisos-get.test.js`
- Uploaded files (mechanics' photos, ficha técnica PDFs) are **not** a public folder. They are served by `GET /api/archivos/:nombre` (`archivos-privados.js`): session (header, or the `cm_arch` HttpOnly cookie the server sets on the first authenticated call, because `<img>` and links cannot send headers), the module's permission (photos → `area_montajes`, `ficha-*.pdf` → `ordenes_produccion`; admins always), and the file must be used by a record (alistamientos/mantenimientos `fotos`, a ficha's `fichaTecnica`) or have been uploaded in the last hour. The old `/alistamiento/uploads/x` and `/fichas-tecnicas/x` addresses redirect there. Never add `express.static` over `UPLOADS_DIR`. Tests: `pruebas/archivos.test.js`

## Auditorías de Calidad

`modulos/auditorias-calidad/`, route `/auditorias-calidad`, data in `auditorias_calidad` (partitioned by day, like `contador_produccion`).

**Tablero tab (13/10/2026).** A third tab of the quality panel: one card per active module (ring with the **simple average** of the audits' `pctAceptacion` in the range, count, assigned auditor(s)). Green ≥ the current minimum (`minAceptacionCalidad`), red below it ("Rechazado"), grey if not audited. Own date filter (default Hoy, independent of the panel's), a filter by auditor (only the modules assigned to her; combines with the eye), the filters row (date, counter, Excel, "Volver al menú") sits BELOW the tabs on all three tabs; the auditor filter is a button+list like the date/modules ones; the pills aceptados/rechazados/sin auditar are filters (one at a time, click again to clear; their counts ignore the state filter); no "Mínimo exigido" pill, an eye button to hide modules (kept per device in `localStorage` `aud_tablero_ocultos`, keyed by module id), refreshes every 60 s while the tab is visible, tap a card for the audits of that module (tap a row → the existing detail). Data: `GET /api/auditorias-calidad/tablero?desde&hasta` (admin of Calidad) returns the active modules, their auditors, the audits and the minimum; the screen does the averages.

**Who audits each module is assigned in Configuraciones → Módulos** (✏️, field "Auditoras de calidad", several allowed), stored in `app_config._modulos_auditora` = `{ moduleId: [names] }` like `_modulos_supervisora`. The list of people comes from `GET /api/auditoras-calidad` (needs the `configuraciones` permission; names only). If that list can't be loaded the form leaves the module's assignment untouched. `audModulosDe(cedula)` (the "your modules first" hint in Nueva auditoría) now reads this map; the old per-person `auditorias_asignaciones` (hidden "Auditoras" tab) is only a fallback.

**An audit in progress is never lost and cannot be left.** From "Comenzar auditoría" the server's timer (the `sello`, valid 12 h) is running. The screen saves a draft in `localStorage` (`aud_borrador:<AUDITORA>`) on every change (`guardarBorrador()`, called from `marcadores()`): OP, person, operation, quantities, defects (including the one being typed), notes, the `sello` and the local start time. On load `entrarA()` calls `restaurarBorrador()` before showing the menu, and the chronometer continues from the stored start (the official duration is still computed by the server from the `sello`, so reload time counts). While the `sello` is set (`fijarEnCurso(true)`) there is no Cancelar, Cambiar datos, Cambiar de OP, the selectors are disabled, `irAlMenu()` and the header "Volver" refuse, browser Back is trapped and `beforeunload` warns; the only exit is **Guardar auditoría**. If the server answers that the chronometer is no longer valid, or the draft is older than 12 h, the draft is discarded so the screen cannot stay stuck. Never call `guardarBorrador()` with `_desde` unset (it would overwrite a good draft): restore sets `_desde` before filling the fields.

Who may use it: a **person** who signed in to the app with their national ID (the normal `/api/entrar` session) and either has the `auditorias_calidad` permission on their access account or is marked as administrator. There is **no second sign-in** — the module opens straight away with the session, exactly like Control de Ingresos. A profile ("equipo") session has no person behind it, so `audQuien` answers 401 and the page shows a notice instead of a form.

The auditor's name is taken from the **employee record** (`cuentaDeCedula(...).emp.name`), never from anything the client sends. `requireAuditor` builds `req.aud = { n, a, cedula }` on every request (so revoking the permission or deactivating the person takes effect at once); `requireAdminCalidad` requires `a === true`, i.e. the **administrator** flag of the access account. Administrators can audit and see everyone's audits; the others see only their own.

The signed **pase** (`audFirmarPase` / `audLeerPase`, secret derived from `SESSION_SECRET`) is no longer an entry ticket: it only **seals the stopwatch** (`/iniciar` returns it, the save checks it belongs to the same person).

Never filter by an auditor name that came from the client — always `req.aud.n`.

**Panel de calidad** (administrators only) is one full-width screen (`main.ancho`) with three tabs: *Lista de auditorías* (one date-range button like Registros — the only global filter —, Excel and Back on the same row; a filter box under every column title, applied to the rows only so the cursor is not lost; table with date, turn hour — "1ra, 2da…" computed in the browser with `MillarEficiencia.detectarTurno/infoHoraDe` over `/api/turnos` —, auditor, module, reference, OP, audited units, % and result; plus correct/delete/Excel), *Dashboard* (uses ONLY the date range — never the list's column filters — : totals, bar charts, and which assigned modules were audited) and *Auditoras* (one button per auditor → her figures, **assigned modules**, **tasks**, her audits).

All the audit tables (panel list, each auditor's list, *Mis auditorías*) share the **Registros** table design: blue header, white search row under it (sticky; the list scrolls inside its own box, height set by `ajustarTabla()`), bordered cells, IBM Plex Mono figures, line-icon actions. If Registros' look changes, change `.tabla-cal` here too.

Two extra stores (both in `FILES`, so they are backed up): `auditorias_asignaciones` (`{ [cedula]: { modulos, actualizado, por } }`) and `auditorias_tareas` (`[ { id, cedula, texto, limite, estado, creadaEn, creadaPor, hechaEn, hechaPor } ]`). They are keyed by **national ID**, not by name. Auditors = accounts with the `auditorias_calidad` permission, plus administrators who have already audited. Assigned modules are **only a guide**: they appear first (optgroup "Tus módulos") in *Nueva auditoría*, nothing is blocked. Admin routes: `GET /auditoras`, `PUT /auditoras/:cedula/modulos`, `POST|PATCH|DELETE /tareas`; an auditor uses `GET /mis-tareas` and `PATCH /mis-tareas/:id` (she can only mark her own task done/pending). `/yo` also returns `modulos` and `tareasPendientes`.

## Environment variables

| Variable | Needed | Purpose |
|---|---|---|
| `PORT` | no (3000) | Port Node listens on |
| `STORAGE` | yes (`sqlite`) | Storage engine |
| `DATA_DIR` | yes | Where data lives — `/var/www/control-millar/data` on the droplet |
| `SQLITE_PATH` | yes | The database file |
| `UPLOADS_DIR` | yes | Photos and PDFs |
| `SESSION_SECRET` | yes | Without it every restart logs everyone out |
| `AUTH_ENFORCE` | yes (`true`) | Requires a session for the API |
| `RESET_PASS` | recommended | Guards `/admin/backup` and `/admin/reset` |
| `TZ` | yes (`America/Bogota`) | The server would otherwise run in UTC |
| `ALLOWED_ORIGIN` | no | CORS restriction |
| `MQTT_BROKER_URL`, `MQTT_USER`, `MQTT_PASS`, `MQTT_TOPIC_LUCES` | no (see note) | Own MQTT broker for the Pick-to-Light lights (`mqtt-luces.js`). If `MQTT_BROKER_URL` is set but anything is missing or insecure (public broker, no credentials, guessable topic) the lights stay OFF and the reason is logged; it never falls back to the public broker. `MQTT_CANAL_MAX` optional (255). **Transition:** with none of these set the old public broker.hivemq.com keeps being used with a loud warning; `MQTT_LUCES_LEGACY=false` turns the lights off instead |
| `PERMISOS_GET_MODO` | no (`observar`) | `observar` only logs "habria negado…" for GET routes whose module permission the person lacks; `aplicar` answers 403. Table in `permisos-get.js` |
| `TRUST_PROXY` | no | Whose `X-Forwarded-For` to believe for the real client IP. Empty = only the local nginx (correct today). See `limitador.js` |

## Deployment

Runs on a **DigitalOcean droplet: 167.99.228.147**.

| Piece | Location |
|---|---|
| Code | `/var/www/control-millar` |
| Data | `/var/www/control-millar/data` |
| Config with secrets | `/etc/millar/ecosystem.config.js` (outside the repo — deploys never touch it) |
| Backups | `/root/respaldos-millar/` |
| nginx | `/etc/nginx/sites-available/millar` |

Node listens on 3000 internally; nginx serves port 80 and proxies. PM2 keeps the process up and starts it at boot. A push to `main` triggers GitHub Actions, which runs `deploy/deploy.sh` over SSH: pull, install, syntax check, restart, and verify the app really answers — **rolling back automatically if it does not**.

`deploy.sh` runs `npm ci`, so `package.json` and `package-lock.json` must stay in sync or the deploy fails — it now checks this first and says so in plain Spanish instead of failing with npm's error. Before restarting, it also runs the app end to end with `SMOKE_TEST=1` and a throwaway `DATA_DIR`, so a missing `require()` is caught before PM2 reloads rather than after.

`deploy.sh` copies itself to `/usr/local/bin/millar-deploy`, which is what GitHub Actions actually runs. **That self-update was broken** (a literal `
` where a line continuation belonged, so the condition always failed) and was fixed on 28/09/2026. The first deploy after that fix still runs the old installed copy, so install it once by hand:

```bash
cd /var/www/control-millar && git pull && cp deploy/deploy.sh /usr/local/bin/millar-deploy && chmod +x /usr/local/bin/millar-deploy
```

More detail in `deploy/README.md`.

## Known technical debt

From an external audit (28/09/2026). Blocks 1 to 4 were applied; what follows is what was deliberately left.

| Item | Why it is still open |
|---|---|
| `server.js` is ~9,100 lines | Splitting it into modules is the audit's biggest item. Deliberately **not** done: it moves thousands of lines in a factory that is running, and the benefit is for whoever edits the code, not for the plant. If it is ever done, do it during a shutdown, one module per commit. |
| `xlsx` comes from a vendored tarball, not from npm | npm only has 0.18.5 (two CVEs). SheetJS publishes the fixed versions only on its own CDN, so `vendor/xlsx-0.20.3.tgz` (official tarball from https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz, sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==) is committed and `package.json` points at it (`file:vendor/…`): no network at deploy time and the hash is pinned. Server, `/xlsx.full.min.js` (served from node_modules) and the Punto Seguro client use it. Compared against 0.18.5 on read/write/CSV: same results; the only difference is that date serials are now exact (0.18.5 drifted ~15 s). To update: download the new tarball from the same CDN, replace the file, `npm install ./vendor/xlsx-X.Y.Z.tgz` in the root AND in `modulos/punto-seguro/client` (then `npm run build` there and commit `dist/`). **Still worth doing once:** import one real Excel of each kind (asistencia, incentivos, órdenes, fichas, lotes) and compare. |
| `npm audit` (12/10/2026): `braces`/`chokidar`/`nodemon`, `uuid` | `braces` comes only through `nodemon`, a dev tool that is not installed in production (`npm ci --omit=dev`). `uuid` (<11.1.1) fails only for v3/v5/v6 called with a buffer; the code only uses `v4()` without a buffer, so it is not reachable (fixing it means a major bump to an ESM-only uuid). `npm audit fix --force` would also downgrade nodemon: do not run it. |
| `body-parser`, `qs`, `brace-expansion` advisories | All reachable only through Express's own dependency tree. `npm audit fix` clears them but bumps Express, which deserves its own deploy. |
| Equipos (profile sign-in) still exist | `/api/login` keeps working for the non-admin profiles (Televisor, Mecánicos, Modulos…). The goal is that everyone signs in with national ID; that is a later step. |
| WebSocket echo | On `ci_update_request` every connected client runs `commitChange`, which sends the same change back — N² messages. Reported, not touched. |
| Rate limit is per IP | Every tablet on the floor shares one IP, so one operator can use up everyone's quota. Limiting by `req.auth.user` when there is a session would fix it. |
| The `noCuenta` rule is written out by hand | `personasDeModulo`, `presentesDelDia`, `asistencia-modulos`, `asistencia-modulos-rango` and `incentivos-individuales` each filter it separately. One shared `esCuentaParaMetas(nombre)` would keep them from drifting apart. |
| `slots` → `multiImps` migration never cleans up | It runs on every start and leaves the old `slots` behind. |
| No tests | `millar-eficiencia.js` is the obvious place to start: it is pure functions and it is the most delicate piece. `node --test` ships with Node, so no new dependency. |

## Perfiles Programador y Administrador (retirados)

They no longer exist. Administration belongs to **people** whose access account has `admin: true` (sign in with national ID). `retirarPerfilesAdmin()` deletes both profiles (users store, `_usuarios_extra`, `_perfil_members`), cuts their sessions, and runs at start and every time an access account is saved — but **only if at least one active administrator with a password exists** (`administradoresConClave()`), so it can never lock everyone out. Until then the profiles stay and `/api/perfiles` still lists the Programador. While `perfilesRetiradosVigente()` is true, an old open screen cannot bring them back through `/api/app-config`. `ensureUsersFile` still creates a Programador on a **brand-new** install so there is something to sign in with the first time. `auth.rol === 'programador'` shortcuts were removed: permissions come from the users store or the access account.
