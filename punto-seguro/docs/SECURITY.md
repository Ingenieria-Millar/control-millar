# Seguridad — Decisiones y mitigaciones

## Vulnerabilidades conocidas en `xlsx` (sin parche oficial en npm)

La librería `xlsx` (SheetJS), usada para la importación masiva de trabajadores
desde Excel/CSV, tiene dos vulnerabilidades conocidas que **no tienen parche
publicado en el registro de npm**:

- **Prototype Pollution** — [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)
- **ReDoS (Denegación de servicio por expresión regular)** — [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)

SheetJS mantiene versiones corregidas, pero solo las distribuye desde su
propio CDN (`cdn.sheetjs.com`), no desde el registro público de npm. Instalar
paquetes desde una URL fuera de npm cambia el modelo de confianza del
proyecto, así que en vez de eso se aplicó una mitigación de **defensa en
profundidad** que neutraliza el impacto de ambas vulnerabilidades sin
necesidad de esa dependencia externa.

### Mitigación aplicada: aislar el parseo en un Web Worker con timeout

Todo el parseo de archivos ocurre en `client/src/workers/excelParser.worker.js`,
orquestado por `client/src/services/excelImport.service.js`:

1. **Prototype Pollution → contenida.** Un Web Worker tiene su propio scope
   global, completamente aislado del hilo principal. Si un archivo maliciero
   lograra contaminar `Object.prototype`, solo afectaría al Worker — que se
   destruye (`terminate()`) inmediatamente después de cada parseo. El hilo
   principal y el resto de la aplicación nunca se ven afectados.
2. **ReDoS → abortable.** El servicio orquestador aplica un timeout
   (15 segundos). Si el Worker se cuelga procesando un archivo con un patrón
   patológico, se lo termina a la fuerza (`worker.terminate()`), liberando el
   hilo principal sin congelar la interfaz del usuario.
3. **Capas adicionales de defensa** (independientes del Worker):
   - Validación de extensión (`.xlsx`, `.xls`, `.csv`) y tamaño máximo (5MB)
     antes de siquiera enviar el archivo al Worker.
   - Límite de 5.000 filas por archivo.
   - Opciones de parseo mínimas (`cellFormula:false`, `cellStyles:false`,
     `bookVBA:false`, etc.) que desactivan las rutas de código menos
     necesarias y más propensas a este tipo de problemas.
   - Mapeo de columnas por **lista blanca explícita** (`buildHeaderMap` /
     `mapRowToWorker` en `excelMapping.js`, con `Object.create(null)`): nunca
     se copian claves arbitrarias del archivo, así que una clave como
     `__proto__` en una celda no tiene ningún efecto.

Esta combinación fue verificada con una prueba funcional real: un archivo
Excel con una fila que incluía una clave `__proto__` maliciosa se procesó sin
contaminar `Object.prototype`.

### Revisión periódica

Se recomienda revisar cada 3–6 meses si SheetJS publica una versión corregida
en el registro de npm (`npm view xlsx versions`) para poder retirar esta capa
de mitigación y actualizar directamente.

## Otras decisiones de seguridad relevantes

- `pdfjs-dist` se actualizó de `3.11.174` (versión del CDN original, con una
  vulnerabilidad de severidad **alta** de ejecución arbitraria de JavaScript)
  a `^4.10.38`, sin esa vulnerabilidad.
- `multer` se fijó en `^2.x` (la rama 1.x tiene vulnerabilidades conocidas).
- Todas las entradas de la API se validan con `zod` antes de tocar la base de
  datos (ver `server/src/validators/`).
- Los PDFs y plantillas se almacenan como `BYTEA` en PostgreSQL con acceso
  únicamente a través de la capa de repositorios (nunca SQL directo desde
  controladores).
