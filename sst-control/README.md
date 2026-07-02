# Control de Visitantes · SST

Aplicativo web para el **control de acceso de visitantes y salidas de personal**, diseñado para cumplimiento en **Seguridad y Salud en el Trabajo (SST)** en Colombia.

Funciona como una **aplicación web estática** (HTML + CSS + JS puro), sin necesidad de backend ni base de datos externa. Los datos se persisten en `localStorage` del navegador.

---

## ✅ Funcionalidades principales

### 👥 Módulo Visitantes
- Registro de ingreso con: tipo/número de documento (CC, CE, PA, TI, PPT), nombre, empresa, EPS, ARL, tipo de sangre, contacto de emergencia y equipos de cómputo
- Firma táctil en tablet (canvas)
- Autocompletado para visitantes recurrentes (reutiliza firma y datos)
- Registro de salida con hora automática
- Declaración de normas SST obligatoria

### 🚶 Módulo Salidas de Personal
- **Salida:** registro de salidas con motivo, destino, hora estimada de regreso y campo de autorización con autocompletado de área
- **Regreso:** lista de personal fuera con registro de hora de regreso automática
- **Entrada directa:** para empleados que inician jornada fuera de la empresa
- Cierre automático de pendientes vencidos como "No regresó"
- Carga masiva de nómina desde Excel (.xlsx), CSV o TXT
- Detección automática del orden de columnas (Nombre/Cédula)

### 📊 Historial y exportación
- Historial filtrable por nombre, documento y fecha
- Exportación a **Excel (.xlsx)** con columnas formateadas, filtros automáticos y fila de encabezado fija
- Detalle completo por registro (incluye firma)

### ⚙️ Configuración
- Gestión de listas de EPS y ARL (actualizables)
- Carga y edición de lista de personal para autocompletado

---

## 🚀 Despliegue rápido

### Opción 1 — Abrir directamente en el navegador
```bash
# Simplemente abre index.html en cualquier navegador moderno
open index.html   # macOS
start index.html  # Windows
```

### Opción 2 — Servidor de desarrollo local
```bash
npm install
npm run dev
# Abre http://localhost:3000
```

### Opción 3 — Render (Static Site) — Recomendado para producción
1. Crea una cuenta en [render.com](https://render.com)
2. Conecta este repositorio de GitHub
3. Render detecta `render.yaml` automáticamente y despliega como **Static Site**
4. Sin configuración adicional requerida

### Opción 4 — Otros hostings estáticos
Compatible con: **GitHub Pages**, **Netlify**, **Vercel**, **Cloudflare Pages**

Para GitHub Pages:
```bash
# En Settings > Pages, selecciona la rama main y carpeta / (root)
```

---

## 📁 Estructura del proyecto

```
control-visitantes-sst/
├── index.html              # Aplicación completa (HTML + CSS + JS inline)
├── assets/
│   └── js/
│       └── xlsx.full.min.js  # SheetJS v0.18.5 (Excel read/write, local)
├── package.json
├── render.yaml             # Configuración de despliegue en Render
├── .gitignore
├── .env.example
└── README.md
```

---

## 💾 Almacenamiento de datos

| Contexto | Almacenamiento | Alcance |
|---|---|---|
| Dentro de Claude.ai | `window.storage` (nube) | Compartido entre dispositivos |
| Navegador / Servidor | `localStorage` | Solo en ese dispositivo/navegador |

> ⚠️ **Importante para producción:** los datos en `localStorage` son locales al navegador. Si necesitas datos compartidos entre múltiples dispositivos o usuarios, considera migrar a un backend con base de datos.

---

## 🖨️ Uso recomendado en recepción

1. Abre la URL de la app en la tablet de recepción
2. En **Configuración**, ingresa el nombre de tu empresa
3. Carga la lista de personal desde **Configuración → Lista de personal**
4. Configura las listas de **EPS y ARL** vigentes
5. Usa el módulo de **Visitantes** para ingresos/salidas de externos
6. Usa el módulo de **Salidas de personal** para movimientos del equipo

---

## 🛠️ Dependencias

| Librería | Versión | Uso | Distribución |
|---|---|---|---|
| SheetJS (xlsx) | 0.18.5 | Leer/escribir Excel | Local (`assets/js/`) |
| Google Fonts | — | Tipografías (Barlow Condensed, Inter, IBM Plex Mono) | CDN (requiere internet) |

---

## 📋 Requisitos del navegador

- Chrome 90+, Edge 90+, Firefox 88+, Safari 14+
- Requiere JavaScript habilitado
- Para firma táctil: pantalla táctil (tablet) o mouse

---

## 📄 Licencia

Uso interno organizacional. No redistribuir sin autorización.
