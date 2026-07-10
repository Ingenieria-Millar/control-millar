# Punto Seguro — Plataforma SG-SST

> ⚠️ **Estado actual: Fase 1 de la refactorización (scaffolding).**
> El código funcional completo (trabajadores, firma electrónica, PDFs, Excel,
> capacitaciones, evaluaciones, dashboard) se migra en las fases siguientes.
> Este README se completa en la Fase 9 con la documentación final.

## ¿Qué es esto?

Refactorización profesional del archivo único `Punto_Seguro_App.html` hacia una
arquitectura de nivel empresarial: **frontend** (JavaScript ES6 modular + Vite)
y **backend** (Node.js + Express + PostgreSQL), lista para desplegar en Render.

## Estructura del proyecto

```
punto-seguro/
├── client/                  # Frontend (Vite, JS ES6 modular)
│   ├── src/
│   │   ├── components/      # Piezas de UI reutilizables
│   │   ├── pages/            # Vistas (Inicio, Trabajadores, Firma, etc.)
│   │   ├── services/          # Comunicación con la API (httpClient, etc.)
│   │   ├── repositories/      # Abstracción de acceso a datos del lado cliente
│   │   ├── utils/ helpers/    # Funciones puras y utilidades
│   │   ├── config/ constants/ # Configuración y constantes
│   │   └── styles/            # CSS
│   └── public/
├── server/                  # Backend (Express + PostgreSQL)
│   ├── src/
│   │   ├── routes/ controllers/ services/ repositories/  # Capas de la API
│   │   ├── middlewares/       # Manejo centralizado de errores, etc.
│   │   ├── config/            # env.js, database.js
│   │   └── utils/
│   ├── migrations/            # Migraciones SQL versionadas
│   └── scripts/migrate.js     # Runner de migraciones
├── Dockerfile
├── render.yaml
└── package.json              # Workspaces (client + server)
```

## Requisitos

- Node.js ≥ 20
- PostgreSQL ≥ 14 (local o en Render)

## Instalación local

```bash
git clone <tu-repo>
cd punto-seguro
npm install                     # instala client y server (workspaces)

cp server/.env.example server/.env   # completa DATABASE_URL y JWT_SECRET
cp client/.env.example client/.env

npm run migrate --workspace=server   # crea las tablas y datos semilla en PostgreSQL
npm run dev                          # levanta client (5173) y server (4000)
```

Abre `http://localhost:5173`.

## API REST disponible (Fase 2)

Todas las rutas cuelgan de `/api`:

| Recurso | Rutas |
|---|---|
| Salud | `GET /health` |
| Trabajadores | `GET,POST /trabajadores` · `GET,PUT,DELETE /trabajadores/:id` · `POST /trabajadores/:id/documentos-firmados` · `GET /trabajadores/:id/documentos-firmados/:docId` |
| Plan de capacitación | `GET,POST /capacitaciones/plan` · `PUT,DELETE /capacitaciones/plan/:id` |
| Sesiones | `GET,POST /capacitaciones/sesiones` · `POST /capacitaciones/sesiones/:id/asistentes` · `PATCH,DELETE /capacitaciones/sesiones/:id/asistentes/:attendeeId` |
| Evaluaciones | `GET,POST /evaluaciones` · `GET,PUT,DELETE /evaluaciones/:id` |
| Resultados | `GET,POST /resultados` |
| Plantillas de anexos | `GET,POST /paquete/plantillas` · `GET /paquete/plantillas/:id/archivo` · `DELETE /paquete/plantillas/:id` |
| Posiciones de firma | `GET,POST /paquete/posiciones-firma` · `DELETE /paquete/posiciones-firma/:fileKey` |
| Inducción | `GET,PUT /paquete/induccion` |

## Despliegue en Render

1. Sube este repositorio a GitHub.
2. En Render: **New → Blueprint**, selecciona el repo (usa `render.yaml`).
3. Render crea automáticamente la base de datos PostgreSQL y el servicio web
   (Docker, ver `Dockerfile`), inyectando `DATABASE_URL` y generando `JWT_SECRET`.
4. Tras el primer deploy, ejecuta las migraciones desde el Shell de Render:
   ```bash
   node scripts/migrate.js
   ```

## Roadmap de fases

- [x] Fase 1 — Scaffolding y configuración
- [x] Fase 2 — Backend: base de datos y API REST
- [x] Fase 3 — Servicios del cliente (reemplazo de `window.storage`)
- [x] Fase 4 — Firma electrónica y PDF
- [x] Fase 5 — Importación desde Excel
- [x] Fase 6 — Componentes y páginas
- [x] Fase 7 — Enlaces públicos (onboarding, quiz)
- [x] Fase 8 — Routing, estado global y estilos

**Proyecto completo y verificado de extremo a extremo.** Las 8 fases están
implementadas, probadas contra una base de datos PostgreSQL real (no solo
"compila"), y listas para desplegar en Render siguiendo las instrucciones de
arriba.

## Rendimiento

El bundle de entrada pesa ~3KB. `pdf-lib`, `pdfjs-dist` y el Worker de Excel
(~1.5MB en total) solo se descargan cuando el usuario visita una sección que
realmente los necesita (Firma, Paquete de ingreso, Trabajadores), gracias a
`import()` dinámico por ruta en `client/src/router/AppRouter.js`.

## Seguridad

Ver [docs/SECURITY.md](./docs/SECURITY.md) para las mitigaciones aplicadas
(en particular, cómo se neutralizaron las vulnerabilidades conocidas de `xlsx`
sin depender de un parche externo al registro de npm).
- [ ] Fase 5 — Importación desde Excel
- [ ] Fase 6 — Componentes y páginas
- [ ] Fase 7 — Enlaces públicos (onboarding, quiz)
- [ ] Fase 8 — Routing, estado global y estilos
- [ ] Fase 9 — Documentación final y checklist de calidad

## Licencia

MIT — ver [LICENSE](./LICENSE).
