const pptxgen = require("pptxgenjs");

// ─── PALETA ───────────────────────────────────────────────────────────────────
const C = {
  navyDark:  "0F2340",   // fondo oscuro
  navy:      "1E3A5F",   // fondo oscuro secundario
  teal:      "0D7377",   // color principal
  mint:      "14BDAC",   // acento
  lightBg:   "F0F4F8",   // fondo claro
  white:     "FFFFFF",
  textDark:  "1A2332",
  textMid:   "3D5A80",
  textMuted: "64748B",
  cardBg:    "FFFFFF",
  cardBg2:   "EBF4F5",
};

const makeShadow = () => ({
  type: "outer", color: "000000", blur: 8, offset: 3, angle: 45, opacity: 0.12
});

let pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author  = "Confecciones Millar";
pres.title   = "Control de Piso Millar — Presentación Gerencia";

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 1 — PORTADA
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.navyDark };

  // Rectángulo decorativo teal izquierdo (bloque, no barra de acento)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 1.6, w: 10, h: 2.8,
    fill: { color: C.navy, transparency: 30 }, line: { color: C.navy, transparency: 30 }
  });

  // Círculo grande decorativo fondo
  s.addShape(pres.shapes.OVAL, {
    x: 6.5, y: -1.2, w: 5, h: 5,
    fill: { color: C.teal, transparency: 82 }, line: { color: C.teal, transparency: 82 }
  });
  s.addShape(pres.shapes.OVAL, {
    x: 7.2, y: 3.2, w: 3.5, h: 3.5,
    fill: { color: C.mint, transparency: 88 }, line: { color: C.mint, transparency: 88 }
  });

  // Chip superior
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.6, y: 0.9, w: 2.6, h: 0.42,
    fill: { color: C.mint }, line: { color: C.mint }, rectRadius: 0.08
  });
  s.addText("SOFTWARE DE GESTIÓN", {
    x: 0.6, y: 0.9, w: 2.6, h: 0.42,
    fontSize: 9, bold: true, color: C.navyDark,
    align: "center", valign: "middle", margin: 0
  });

  // Título principal
  s.addText("CONTROL DE PISO", {
    x: 0.6, y: 1.55, w: 8.8, h: 0.9,
    fontSize: 46, bold: true, color: C.white,
    fontFace: "Cambria", align: "left", valign: "bottom", margin: 0
  });
  s.addText("MILLAR", {
    x: 0.6, y: 2.42, w: 5, h: 0.85,
    fontSize: 46, bold: true, color: C.mint,
    fontFace: "Cambria", align: "left", valign: "top", margin: 0
  });

  // Versión
  s.addText("v4.0", {
    x: 5.7, y: 2.55, w: 1.0, h: 0.55,
    fontSize: 13, bold: false, color: C.textMuted,
    align: "left", valign: "middle", margin: 0
  });

  // Subtítulo
  s.addText("Plataforma digital para el seguimiento en tiempo real\nde producción, operarios y recursos en planta de costura", {
    x: 0.6, y: 3.42, w: 7.5, h: 0.9,
    fontSize: 14, color: "A8BFCE", align: "left", valign: "top", margin: 0
  });

  // Footer
  s.addText("Confecciones Millar  ·  " + new Date().getFullYear(), {
    x: 0.6, y: 5.1, w: 8.8, h: 0.3,
    fontSize: 10, color: "4A6278", align: "left", margin: 0
  });

  s.addNotes(
    "Slide de portada. Presentar el software desarrollado a medida para Confecciones Millar. " +
    "Enfatizar que es una solución propia, no un sistema comprado."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 2 — EL PROBLEMA (antes)
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.lightBg };

  // Chip
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.3, w: 2.0, h: 0.35,
    fill: { color: "FEE2E2" }, line: { color: "FEE2E2" }, rectRadius: 0.08
  });
  s.addText("EL RETO", {
    x: 0.5, y: 0.3, w: 2.0, h: 0.35,
    fontSize: 9, bold: true, color: "DC2626",
    align: "center", valign: "middle", margin: 0
  });

  s.addText("¿Qué pasaba antes?", {
    x: 0.5, y: 0.72, w: 9, h: 0.7,
    fontSize: 32, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  // 4 tarjetas de problemas
  const problemas = [
    { icon: "📋", titulo: "Control manual", desc: "Planillas en papel o Excel desactualizados. Datos dispersos, difíciles de cruzar." },
    { icon: "⏳", titulo: "Sin tiempo real", desc: "Los supervisores no sabían el estado de la producción hasta el final del turno." },
    { icon: "📉", titulo: "Incentivos sin control", desc: "Calcular incentivos era tedioso y propenso a errores. Operarios inconformes." },
    { icon: "🔧", titulo: "Mantenimiento reactivo", desc: "Sin registro de averías ni historial de máquinas. Costos imprevistos." },
  ];

  problemas.forEach((p, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.5 + col * 4.75;
    const y = 1.62 + row * 1.85;

    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y, w: 4.4, h: 1.6,
      fill: { color: C.white }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.12,
      shadow: makeShadow()
    });
    s.addText(p.icon + "  " + p.titulo, {
      x: x + 0.25, y: y + 0.2, w: 3.9, h: 0.42,
      fontSize: 14, bold: true, color: C.textDark,
      align: "left", valign: "middle", margin: 0
    });
    s.addText(p.desc, {
      x: x + 0.25, y: y + 0.62, w: 3.9, h: 0.8,
      fontSize: 11, color: C.textMuted,
      align: "left", valign: "top", margin: 0
    });
  });

  s.addNotes(
    "Explicar brevemente el antes. La planta operaba con registros manuales, " +
    "sin visibilidad en tiempo real, y los errores en incentivos generaban conflictos con operarios."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 3 — QUÉ ES (la solución)
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.navy };

  // Decoración
  s.addShape(pres.shapes.OVAL, {
    x: 6.8, y: -0.8, w: 4, h: 4,
    fill: { color: C.mint, transparency: 90 }, line: { color: C.mint, transparency: 90 }
  });

  // Chip
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.6, y: 0.35, w: 2.4, h: 0.38,
    fill: { color: C.mint }, line: { color: C.mint }, rectRadius: 0.08
  });
  s.addText("LA SOLUCIÓN", {
    x: 0.6, y: 0.35, w: 2.4, h: 0.38,
    fontSize: 9, bold: true, color: C.navyDark,
    align: "center", valign: "middle", margin: 0
  });

  s.addText("¿Qué es Control de Piso Millar?", {
    x: 0.6, y: 0.85, w: 8.8, h: 0.75,
    fontSize: 30, bold: true, color: C.white,
    fontFace: "Cambria", align: "left", margin: 0
  });

  // Definición
  s.addText(
    "Es una aplicación web desarrollada a la medida de Confecciones Millar, " +
    "que digitaliza y centraliza el control operativo de la planta de costura en tiempo real.",
    {
      x: 0.6, y: 1.68, w: 8.8, h: 0.8,
      fontSize: 14, color: "B8D4E8", align: "left", margin: 0
    }
  );

  // 3 pilares
  const pilares = [
    { num: "01", titulo: "Tiempo real", desc: "Todos los datos se sincronizan al instante entre pantallas y dispositivos." },
    { num: "02", titulo: "Centralizado", desc: "Un solo lugar para producción, operarios, máquinas e insumos." },
    { num: "03", titulo: "Accesible", desc: "Funciona desde cualquier computador o celular, sin instalar nada." },
  ];

  pilares.forEach((p, i) => {
    const x = 0.5 + i * 3.2;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: 2.7, w: 2.95, h: 2.45,
      fill: { color: "FFFFFF", transparency: 8 }, line: { color: C.mint, pt: 1 }, rectRadius: 0.15
    });
    s.addText(p.num, {
      x: x + 0.2, y: 2.85, w: 1.2, h: 0.55,
      fontSize: 28, bold: true, color: C.mint,
      fontFace: "Cambria", align: "left", margin: 0
    });
    s.addText(p.titulo, {
      x: x + 0.2, y: 3.42, w: 2.55, h: 0.42,
      fontSize: 14, bold: true, color: C.white,
      align: "left", margin: 0
    });
    s.addText(p.desc, {
      x: x + 0.2, y: 3.88, w: 2.55, h: 1.0,
      fontSize: 11, color: "9BB8CC",
      align: "left", margin: 0
    });
  });

  s.addNotes(
    "Control de Piso es 100% web, desarrollado internamente. " +
    "No requiere instalación. Funciona desde el PC de producción, tablets o celulares. " +
    "Todos los cambios se ven en tiempo real gracias a WebSocket."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 4 — CÓMO FUNCIONA (arquitectura simple)
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.lightBg };

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.3, w: 2.8, h: 0.35,
    fill: { color: C.cardBg2 }, line: { color: C.cardBg2 }, rectRadius: 0.08
  });
  s.addText("ARQUITECTURA", {
    x: 0.5, y: 0.3, w: 2.8, h: 0.35,
    fontSize: 9, bold: true, color: C.teal,
    align: "center", valign: "middle", margin: 0
  });

  s.addText("¿Cómo funciona?", {
    x: 0.5, y: 0.72, w: 9, h: 0.65,
    fontSize: 32, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  // Diagrama de flujo horizontal: Dispositivo → Internet → Servidor → Datos
  const capas = [
    { titulo: "Dispositivos", desc: "PC, tablet\no celular", icon: "💻", color: "3B82F6" },
    { titulo: "Internet", desc: "Conexión\nsegura HTTPS", icon: "🌐", color: C.textMuted },
    { titulo: "Servidor\nen la nube", desc: "Render.com\n(siempre activo)", icon: "☁️", color: C.teal },
    { titulo: "Datos", desc: "Guardados de\nforma segura", icon: "🗄️", color: "7C3AED" },
  ];

  capas.forEach((c, i) => {
    const x = 0.4 + i * 2.35;
    const boxW = 2.05;

    // Caja
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: 1.55, w: boxW, h: 2.8,
      fill: { color: C.white }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.14,
      shadow: makeShadow()
    });

    // Ícono
    s.addText(c.icon, {
      x, y: 1.72, w: boxW, h: 0.7,
      fontSize: 28, align: "center", valign: "middle", margin: 0
    });

    // Título capa
    s.addText(c.titulo, {
      x, y: 2.55, w: boxW, h: 0.55,
      fontSize: 13, bold: true, color: C.textDark,
      align: "center", valign: "middle", margin: 0
    });

    // Descripción
    s.addText(c.desc, {
      x: x + 0.1, y: 3.14, w: boxW - 0.2, h: 1.0,
      fontSize: 11, color: C.textMuted,
      align: "center", valign: "top", margin: 0
    });

    // Flecha entre capas
    if (i < capas.length - 1) {
      s.addText("→", {
        x: x + boxW, y: 2.7, w: 0.32, h: 0.45,
        fontSize: 18, bold: true, color: C.mint,
        align: "center", valign: "middle", margin: 0
      });
    }
  });

  // Nota de tiempo real
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 4.55, w: 9, h: 0.72,
    fill: { color: "E0F2F1" }, line: { color: "B2DFDB", pt: 1 }, rectRadius: 0.1
  });
  s.addText(
    "⚡  Tiempo real garantizado: la tecnología WebSocket actualiza todas las pantallas simultáneamente, " +
    "sin necesidad de refrescar la página.",
    {
      x: 0.7, y: 4.55, w: 8.6, h: 0.72,
      fontSize: 11.5, color: "005F5A",
      align: "left", valign: "middle", margin: 0
    }
  );

  s.addNotes(
    "Explicar que la app vive en la nube (Render.com), " +
    "accesible desde cualquier navegador. Los datos se guardan en el servidor, no en el equipo local. " +
    "El WebSocket es lo que hace que todos vean los cambios al instante."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 5 — VISTA GENERAL DE MÓDULOS
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.lightBg };

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.28, w: 2.2, h: 0.35,
    fill: { color: C.cardBg2 }, line: { color: C.cardBg2 }, rectRadius: 0.08
  });
  s.addText("MÓDULOS", {
    x: 0.5, y: 0.28, w: 2.2, h: 0.35,
    fontSize: 9, bold: true, color: C.teal,
    align: "center", valign: "middle", margin: 0
  });

  s.addText("Todo en un solo sistema", {
    x: 0.5, y: 0.7, w: 9, h: 0.65,
    fontSize: 32, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  const modulos = [
    { icon: "🏭", nombre: "Producción",         color: "0D9488" },
    { icon: "📦", nombre: "Órdenes",             color: "2563EB" },
    { icon: "💰", nombre: "Incentivos",          color: "7C3AED" },
    { icon: "📊", nombre: "Ingresos",            color: "B45309" },
    { icon: "🧵", nombre: "Tablero CI",          color: "DC2626" },
    { icon: "🔧", nombre: "Mecánicos",           color: "0369A1" },
    { icon: "📋", nombre: "Insumos",             color: "65A30D" },
    { icon: "🪡",  nombre: "Revisión Telas",     color: "9333EA" },
    { icon: "🧺", nombre: "Recogedores",         color: "0F766E" },
    { icon: "⚙️",  nombre: "Hoja de Vida\nMáq.", color: "6B7280" },
    { icon: "🔢", nombre: "Contador\nMódulos",   color: "C2410C" },
    { icon: "🔑", nombre: "Acceso\nSeguro",      color: "1D4ED8" },
  ];

  modulos.forEach((m, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 0.42 + col * 2.34;
    const y = 1.52 + row * 1.32;

    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y, w: 2.16, h: 1.12,
      fill: { color: C.white }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.12,
      shadow: makeShadow()
    });

    // Indicador de color (punto)
    s.addShape(pres.shapes.OVAL, {
      x: x + 0.18, y: y + 0.22, w: 0.28, h: 0.28,
      fill: { color: m.color }, line: { color: m.color }
    });

    s.addText(m.icon + " " + m.nombre, {
      x: x + 0.52, y: y + 0.08, w: 1.56, h: 0.96,
      fontSize: 11, bold: true, color: C.textDark,
      align: "left", valign: "middle", margin: 0
    });
  });

  s.addNotes(
    "La app tiene 12 módulos/pantallas que cubren todas las áreas operativas de la planta. " +
    "Cada módulo está conectado al mismo servidor y se actualiza en tiempo real."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 6 — MÓDULO: PRODUCCIÓN (el más importante)
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.white };

  // Franja izquierda de color
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 3.8, h: 5.625,
    fill: { color: "0D9488" }, line: { color: "0D9488" }
  });
  s.addShape(pres.shapes.OVAL, {
    x: -0.8, y: 3.8, w: 3, h: 3,
    fill: { color: "0F766E", transparency: 50 }, line: { color: "0F766E", transparency: 50 }
  });

  s.addText("🏭", { x: 0.3, y: 0.5, w: 1.2, h: 1.0, fontSize: 42, align: "left", margin: 0 });

  s.addText("Módulo\nProducción", {
    x: 0.3, y: 1.4, w: 3.2, h: 1.4,
    fontSize: 26, bold: true, color: C.white,
    fontFace: "Cambria", align: "left", margin: 0
  });

  s.addText("El corazón del sistema", {
    x: 0.3, y: 2.82, w: 3.2, h: 0.5,
    fontSize: 13, color: "B2DFDB", italic: true, align: "left", margin: 0
  });

  // Funcionalidades (lado derecho)
  const items = [
    { icon: "👁️", t: "Tablero en tiempo real",     d: "Visualiza columnas de trabajo, operarios asignados y piezas producidas al instante." },
    { icon: "📌", t: "Asignación de operarios",    d: "Arrastra y asigna operarios a puestos de trabajo con un clic." },
    { icon: "📈", t: "Seguimiento de metas",       d: "Cada columna muestra avance vs. meta del día para identificar rezagos." },
    { icon: "🔄", t: "Sincronización multi-screen", d: "Varios supervisores pueden ver el tablero simultáneamente desde diferentes equipos." },
  ];

  items.forEach((it, i) => {
    const y = 0.45 + i * 1.2;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 4.1, y, w: 5.6, h: 1.05,
      fill: { color: C.lightBg }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.1,
      shadow: makeShadow()
    });
    s.addText(it.icon + "  " + it.t, {
      x: 4.35, y: y + 0.08, w: 5.1, h: 0.38,
      fontSize: 13, bold: true, color: C.textDark,
      align: "left", margin: 0
    });
    s.addText(it.d, {
      x: 4.35, y: y + 0.48, w: 5.1, h: 0.5,
      fontSize: 11, color: C.textMuted,
      align: "left", margin: 0
    });
  });

  s.addNotes(
    "El módulo de Producción es el más usado. Los supervisores lo tienen abierto todo el día. " +
    "Permite ver en tiempo real cuántas piezas va produciendo cada operario y en qué columna está trabajando."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 7 — MÓDULO: ÓRDENES DE PRODUCCIÓN
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.lightBg };

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.3, w: 3.2, h: 0.35,
    fill: { color: "DBEAFE" }, line: { color: "DBEAFE" }, rectRadius: 0.08
  });
  s.addText("MÓDULO: ÓRDENES DE PRODUCCIÓN", {
    x: 0.5, y: 0.3, w: 3.2, h: 0.35,
    fontSize: 8, bold: true, color: "1D4ED8",
    align: "center", valign: "middle", margin: 0
  });

  s.addText("📦  Órdenes de Producción", {
    x: 0.5, y: 0.75, w: 9, h: 0.72,
    fontSize: 30, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  // Descripción
  s.addText(
    "Gestiona el ciclo completo de cada orden: creación, seguimiento, avance por referencia y cierre.",
    {
      x: 0.5, y: 1.52, w: 9, h: 0.5,
      fontSize: 13, color: C.textMid, align: "left", margin: 0
    }
  );

  // Flujo de estados
  const estados = [
    { e: "Creada",     c: "3B82F6" },
    { e: "En proceso", c: "F59E0B" },
    { e: "Completada", c: "10B981" },
    { e: "Cerrada",    c: "6B7280" },
  ];

  estados.forEach((est, i) => {
    const x = 0.5 + i * 2.38;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: 2.18, w: 2.1, h: 0.62,
      fill: { color: est.c }, line: { color: est.c }, rectRadius: 0.1
    });
    s.addText(est.e, {
      x, y: 2.18, w: 2.1, h: 0.62,
      fontSize: 13, bold: true, color: C.white,
      align: "center", valign: "middle", margin: 0
    });
    if (i < estados.length - 1) {
      s.addText("→", {
        x: x + 2.1, y: 2.26, w: 0.28, h: 0.46,
        fontSize: 16, bold: true, color: C.textMuted,
        align: "center", margin: 0
      });
    }
  });

  // 3 puntos clave
  const pts = [
    { icon: "📎", t: "Referencia por prenda",     d: "Cada orden incluye referencia, tallas, cantidades y plazos de entrega." },
    { icon: "📊", t: "Avance en tiempo real",      d: "Se actualiza automáticamente conforme avanza producción." },
    { icon: "🗂️",  t: "Historial completo",        d: "Consulta órdenes pasadas para análisis y comparativos." },
  ];

  pts.forEach((p, i) => {
    const x = 0.5 + i * 3.17;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: 3.08, w: 2.92, h: 2.12,
      fill: { color: C.white }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.12,
      shadow: makeShadow()
    });
    s.addText(p.icon, {
      x, y: 3.2, w: 2.92, h: 0.55,
      fontSize: 26, align: "center", margin: 0
    });
    s.addText(p.t, {
      x: x + 0.15, y: 3.78, w: 2.62, h: 0.48,
      fontSize: 12, bold: true, color: C.textDark,
      align: "center", margin: 0
    });
    s.addText(p.d, {
      x: x + 0.15, y: 4.3, w: 2.62, h: 0.78,
      fontSize: 11, color: C.textMuted,
      align: "center", margin: 0
    });
  });

  s.addNotes(
    "Las órdenes de producción son el punto de partida para todo el proceso. " +
    "Se crean aquí y luego se vinculan al tablero de producción para seguimiento en tiempo real."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 8 — MÓDULO: INCENTIVOS + INGRESOS
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.white };

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.3, w: 3.2, h: 0.35,
    fill: { color: "EDE9FE" }, line: { color: "EDE9FE" }, rectRadius: 0.08
  });
  s.addText("MÓDULO: INCENTIVOS & INGRESOS", {
    x: 0.5, y: 0.3, w: 3.2, h: 0.35,
    fontSize: 8, bold: true, color: "7C3AED",
    align: "center", valign: "middle", margin: 0
  });

  s.addText("💰  Incentivos & Control de Ingresos", {
    x: 0.5, y: 0.75, w: 9, h: 0.72,
    fontSize: 28, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  // DOS columnas
  // INCENTIVOS
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 1.65, w: 4.35, h: 3.55,
    fill: { color: "FAF5FF" }, line: { color: "DDD6FE", pt: 1 }, rectRadius: 0.14,
    shadow: makeShadow()
  });
  s.addText("Consulta de Incentivos", {
    x: 0.75, y: 1.85, w: 3.85, h: 0.45,
    fontSize: 15, bold: true, color: "7C3AED", align: "left", margin: 0
  });
  const incItems = [
    "Consulta de incentivos por operario y período",
    "Cálculo automático según producción registrada",
    "Reducción de errores y conflictos laborales",
    "Historial de pagos y bonificaciones",
  ];
  incItems.forEach((txt, i) => {
    s.addText([
      { text: "✓  ", options: { bold: true, color: "7C3AED" } },
      { text: txt, options: { color: C.textDark } }
    ], {
      x: 0.75, y: 2.4 + i * 0.62, w: 3.85, h: 0.52,
      fontSize: 12, align: "left", margin: 0
    });
  });

  // INGRESOS
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 5.15, y: 1.65, w: 4.35, h: 3.55,
    fill: { color: "FFFBEB" }, line: { color: "FDE68A", pt: 1 }, rectRadius: 0.14,
    shadow: makeShadow()
  });
  s.addText("Control de Ingresos", {
    x: 5.4, y: 1.85, w: 3.85, h: 0.45,
    fontSize: 15, bold: true, color: "B45309", align: "left", margin: 0
  });
  const ingItems = [
    "Registro de ingreso y salida de operarios",
    "Control de asistencia y puntualidad",
    "Identificación de ausentismo",
    "Reporte por turno y área",
  ];
  ingItems.forEach((txt, i) => {
    s.addText([
      { text: "✓  ", options: { bold: true, color: "B45309" } },
      { text: txt, options: { color: C.textDark } }
    ], {
      x: 5.4, y: 2.4 + i * 0.62, w: 3.85, h: 0.52,
      fontSize: 12, align: "left", margin: 0
    });
  });

  s.addNotes(
    "El módulo de incentivos resuelve uno de los mayores puntos de conflicto en planta. " +
    "Antes los cálculos eran manuales y propensos a errores. " +
    "Ahora la operaria puede consultar sus incentivos en cualquier momento."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 9 — MÓDULOS DE SOPORTE OPERATIVO
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.lightBg };

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.28, w: 3.0, h: 0.35,
    fill: { color: C.cardBg2 }, line: { color: C.cardBg2 }, rectRadius: 0.08
  });
  s.addText("SOPORTE OPERATIVO", {
    x: 0.5, y: 0.28, w: 3.0, h: 0.35,
    fontSize: 9, bold: true, color: C.teal,
    align: "center", valign: "middle", margin: 0
  });

  s.addText("Módulos de apoyo a la operación", {
    x: 0.5, y: 0.7, w: 9, h: 0.65,
    fontSize: 30, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  const soportes = [
    {
      icon: "🔧", titulo: "Registro Mecánicos",
      desc: "Registra alistamientos, mantenimientos preventivos y correctivos. Historial por máquina. Reduce tiempos muertos.",
      color: "0369A1"
    },
    {
      icon: "🧵", titulo: "Tablero CI – Insumos",
      desc: "Faltante de insumos en tiempo real. Solicitudes de insumos con trazabilidad desde la planta.",
      color: "DC2626"
    },
    {
      icon: "🪡",  titulo: "Revisión de Telas",
      desc: "Registro de defectos en telas al ingreso. Reduce reprocesos y devoluciones por mala calidad.",
      color: "9333EA"
    },
    {
      icon: "⚙️",  titulo: "Hoja de Vida Máquina",
      desc: "Ficha técnica por máquina: marca, modelo, historial de mantenimiento y próximas revisiones.",
      color: "6B7280"
    },
    {
      icon: "🧺", titulo: "Conteo Recogedores",
      desc: "Registro y control del conteo de prendas por recogedores. Evita pérdidas y descuadres.",
      color: "0F766E"
    },
    {
      icon: "🔢", titulo: "Contador Módulos",
      desc: "Panel de control de módulos activos en el sistema. Administración de configuración general.",
      color: "C2410C"
    },
  ];

  soportes.forEach((m, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 0.4 + col * 3.2;
    const y = 1.52 + row * 1.85;

    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y, w: 2.95, h: 1.68,
      fill: { color: C.white }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.12,
      shadow: makeShadow()
    });

    s.addText(m.icon + "  " + m.titulo, {
      x: x + 0.2, y: y + 0.15, w: 2.55, h: 0.45,
      fontSize: 13, bold: true, color: m.color,
      align: "left", margin: 0
    });
    s.addText(m.desc, {
      x: x + 0.2, y: y + 0.6, w: 2.55, h: 0.98,
      fontSize: 10.5, color: C.textMuted,
      align: "left", margin: 0
    });
  });

  s.addNotes(
    "Estos módulos son de soporte pero igual de importantes. " +
    "El de mecánicos y hoja de vida de máquina son clave para mantenimiento preventivo. " +
    "El tablero CI evita que paren las líneas por falta de insumos."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 10 — SEGURIDAD Y RESPALDOS
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.navy };

  s.addShape(pres.shapes.OVAL, {
    x: 7.5, y: 2.5, w: 4, h: 4,
    fill: { color: C.mint, transparency: 92 }, line: { color: C.mint, transparency: 92 }
  });

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.6, y: 0.3, w: 2.0, h: 0.38,
    fill: { color: "FCA5A5" }, line: { color: "FCA5A5" }, rectRadius: 0.08
  });
  s.addText("SEGURIDAD", {
    x: 0.6, y: 0.3, w: 2.0, h: 0.38,
    fontSize: 9, bold: true, color: "7F1D1D",
    align: "center", valign: "middle", margin: 0
  });

  s.addText("🔐  Seguridad y Respaldos", {
    x: 0.6, y: 0.8, w: 8.8, h: 0.72,
    fontSize: 30, bold: true, color: C.white,
    fontFace: "Cambria", align: "left", margin: 0
  });

  const segs = [
    { icon: "🔒", t: "Login con contraseña segura",    d: "Autenticación con bcrypt. Sesiones cifradas. Solo accede quien tiene credenciales." },
    { icon: "🛡️",  t: "Comunicación cifrada (HTTPS)",  d: "Todo el tráfico entre el navegador y el servidor viaja encriptado." },
    { icon: "👤", t: "Roles y permisos",               d: "Cada usuario ve solo lo que le corresponde según su rol en la planta." },
    { icon: "💾", t: "Respaldos automáticos",          d: "Los datos se respaldan periódicamente. Disco persistente en la nube." },
  ];

  segs.forEach((seg, i) => {
    const y = 1.72 + i * 0.92;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.6, y, w: 8.8, h: 0.78,
      fill: { color: "FFFFFF", transparency: 10 }, line: { color: "FFFFFF", transparency: 82 }, rectRadius: 0.1
    });
    s.addText(seg.icon + "  " + seg.t, {
      x: 0.85, y: y + 0.07, w: 3.2, h: 0.38,
      fontSize: 13, bold: true, color: C.white,
      align: "left", margin: 0
    });
    s.addText(seg.d, {
      x: 4.1, y: y + 0.12, w: 5.1, h: 0.52,
      fontSize: 11, color: "9BB8CC",
      align: "left", margin: 0
    });
  });

  s.addNotes(
    "La información de la empresa está protegida. " +
    "Solo acceden usuarios registrados. Las contraseñas nunca se guardan en texto plano. " +
    "Los respaldos automáticos garantizan que no se pierda nada si hay un problema."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 11 — ACCESO Y DESPLIEGUE
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.white };

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.28, w: 2.8, h: 0.35,
    fill: { color: C.cardBg2 }, line: { color: C.cardBg2 }, rectRadius: 0.08
  });
  s.addText("ACCESO & DESPLIEGUE", {
    x: 0.5, y: 0.28, w: 2.8, h: 0.35,
    fontSize: 9, bold: true, color: C.teal,
    align: "center", valign: "middle", margin: 0
  });

  s.addText("Siempre disponible, desde cualquier lugar", {
    x: 0.5, y: 0.72, w: 9, h: 0.65,
    fontSize: 28, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  // Stats grandes
  const stats = [
    { val: "24/7",  label: "Disponibilidad",   sub: "Sin interrupciones" },
    { val: "0",     label: "Instalaciones",     sub: "Solo necesitas un navegador" },
    { val: "100%",  label: "En la nube",        sub: "Render.com — infraestructura confiable" },
    { val: "∞",     label: "Dispositivos",      sub: "PC, tablet, celular" },
  ];

  stats.forEach((st, i) => {
    const x = 0.4 + i * 2.35;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: 1.65, w: 2.1, h: 1.72,
      fill: { color: C.lightBg }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.14,
      shadow: makeShadow()
    });
    s.addText(st.val, {
      x, y: 1.78, w: 2.1, h: 0.75,
      fontSize: 36, bold: true, color: C.teal,
      fontFace: "Cambria", align: "center", margin: 0
    });
    s.addText(st.label, {
      x, y: 2.55, w: 2.1, h: 0.38,
      fontSize: 12, bold: true, color: C.textDark,
      align: "center", margin: 0
    });
    s.addText(st.sub, {
      x: x + 0.1, y: 2.92, w: 1.9, h: 0.38,
      fontSize: 9.5, color: C.textMuted,
      align: "center", margin: 0
    });
  });

  // Descripción adicional
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 3.55, w: 9, h: 1.72,
    fill: { color: C.lightBg }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.14
  });

  s.addText("¿Cómo accedo?", {
    x: 0.85, y: 3.72, w: 3.5, h: 0.4,
    fontSize: 13, bold: true, color: C.textDark, align: "left", margin: 0
  });
  s.addText(
    "Abre cualquier navegador (Chrome, Edge, Safari) y escribe la dirección del sistema. " +
    "Inicia sesión con tu usuario y contraseña. Listo. No se instala nada en el equipo.",
    {
      x: 0.85, y: 4.15, w: 4.2, h: 0.98,
      fontSize: 12, color: C.textMuted, align: "left", margin: 0
    }
  );

  s.addText("🌐  cmillar.co", {
    x: 5.5, y: 3.88, w: 3.7, h: 0.6,
    fontSize: 18, bold: true, color: C.teal, align: "center", margin: 0
  });
  s.addText("Dirección de acceso al sistema", {
    x: 5.5, y: 4.48, w: 3.7, h: 0.38,
    fontSize: 11, color: C.textMuted, align: "center", margin: 0
  });

  s.addNotes(
    "El sistema está en la nube en Render.com. " +
    "No hay que instalar nada. Cualquier navegador funciona. " +
    "El acceso es con usuario y contraseña que se asignan individualmente."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 12 — BENEFICIOS Y RESULTADOS
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.lightBg };

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.5, y: 0.28, w: 2.5, h: 0.35,
    fill: { color: "DCFCE7" }, line: { color: "DCFCE7" }, rectRadius: 0.08
  });
  s.addText("BENEFICIOS", {
    x: 0.5, y: 0.28, w: 2.5, h: 0.35,
    fontSize: 9, bold: true, color: "166534",
    align: "center", valign: "middle", margin: 0
  });

  s.addText("¿Qué gana Confecciones Millar?", {
    x: 0.5, y: 0.72, w: 9, h: 0.65,
    fontSize: 30, bold: true, color: C.textDark,
    fontFace: "Cambria", align: "left", margin: 0
  });

  const beneficios = [
    { icon: "⏱️", t: "Ahorro de tiempo",           d: "Menos tiempo en recolección manual de datos. Información disponible al instante para tomar decisiones." },
    { icon: "🎯", t: "Mayor control",               d: "Supervisores y gerencia conocen el estado real de la planta en cualquier momento del día." },
    { icon: "💼", t: "Reducción de errores",        d: "Los cálculos automáticos eliminan errores humanos en incentivos, conteos y registros." },
    { icon: "📊", t: "Trazabilidad completa",       d: "Historial de producción, mantenimientos, ingresos e insumos disponible para auditorías y análisis." },
    { icon: "🤝", t: "Clima laboral",               d: "Los operarios pueden consultar sus incentivos, reduciendo disputas y aumentando confianza." },
    { icon: "🚀", t: "Escalabilidad",               d: "El sistema está listo para crecer: nuevos módulos, más usuarios, más funcionalidades." },
  ];

  beneficios.forEach((b, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 0.4 + col * 3.2;
    const y = 1.55 + row * 1.88;

    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y, w: 2.95, h: 1.72,
      fill: { color: C.white }, line: { color: "E2E8F0", pt: 1 }, rectRadius: 0.12,
      shadow: makeShadow()
    });
    s.addText(b.icon + "  " + b.t, {
      x: x + 0.2, y: y + 0.15, w: 2.55, h: 0.42,
      fontSize: 13, bold: true, color: C.textDark,
      align: "left", margin: 0
    });
    s.addText(b.d, {
      x: x + 0.2, y: y + 0.6, w: 2.55, h: 1.0,
      fontSize: 10.5, color: C.textMuted,
      align: "left", margin: 0
    });
  });

  s.addNotes(
    "Este slide resume el valor del sistema para la empresa. " +
    "Énfasis en tiempo real, reducción de errores en incentivos y trazabilidad."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE 13 — CIERRE
// ═══════════════════════════════════════════════════════════════════════════════
{
  let s = pres.addSlide();
  s.background = { color: C.navyDark };

  s.addShape(pres.shapes.OVAL, {
    x: -1, y: -1, w: 5, h: 5,
    fill: { color: C.teal, transparency: 88 }, line: { color: C.teal, transparency: 88 }
  });
  s.addShape(pres.shapes.OVAL, {
    x: 7, y: 3, w: 4, h: 4,
    fill: { color: C.mint, transparency: 90 }, line: { color: C.mint, transparency: 90 }
  });

  // Chip
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 3.5, y: 0.65, w: 3, h: 0.42,
    fill: { color: C.mint }, line: { color: C.mint }, rectRadius: 0.1
  });
  s.addText("CONFECCIONES MILLAR", {
    x: 3.5, y: 0.65, w: 3, h: 0.42,
    fontSize: 9, bold: true, color: C.navyDark,
    align: "center", valign: "middle", margin: 0
  });

  s.addText("Un sistema hecho\na nuestra medida.", {
    x: 1, y: 1.28, w: 8, h: 1.7,
    fontSize: 40, bold: true, color: C.white,
    fontFace: "Cambria", align: "center", margin: 0
  });

  s.addText(
    "Control de Piso Millar digitaliza la operación, reduce errores y\n" +
    "pone la información correcta en manos de quien la necesita.",
    {
      x: 1, y: 3.05, w: 8, h: 0.9,
      fontSize: 14, color: "8BAFC4", align: "center", margin: 0
    }
  );

  // Contacto
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 3.0, y: 4.1, w: 4, h: 0.5,
    fill: { color: "FFFFFF", transparency: 10 }, line: { color: C.mint, pt: 1 }, rectRadius: 0.1
  });
  s.addText("ingenieriamillar@cmillar.co", {
    x: 3.0, y: 4.1, w: 4, h: 0.5,
    fontSize: 12, color: C.mint, align: "center", valign: "middle", margin: 0
  });

  s.addNotes(
    "Cierre de presentación. Abrir espacio para preguntas. " +
    "Recordar que cualquier duda técnica o de uso puede canalizarse por correo."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTAR
// ═══════════════════════════════════════════════════════════════════════════════
const OUTPUT = "Control_de_Piso_Millar_Gerencia.pptx";
pres.writeFile({ fileName: OUTPUT }).then(() => {
  console.log("✅  Presentación generada:", OUTPUT);
}).catch(err => {
  console.error("❌  Error:", err);
});
