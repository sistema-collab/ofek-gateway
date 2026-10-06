// Rutas que NO pasan por ningún rate limiter del gateway. Coincidencia
// EXACTA de path (no por prefijo): nada que cuelgue de estas rutas queda
// exento por accidente.
//
// - Webhook de estados de WhatsApp de Meta: Meta manda ~3 eventos por
//   mensaje (sent/delivered/read), desde IPs compartidas, y un 429 le haría
//   perder estados. El módulo lo protege con validación de firma y un
//   limiter propio que sólo cuenta errores (ver ofek-modulo-cobranza,
//   CLAUDE.md, sección Webhook).
const RUTAS_SIN_LIMITER = ['/modulos/cobranza/webhooks/whatsapp'];

function esRutaSinLimiter(path) {
  const normalizado = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return RUTAS_SIN_LIMITER.includes(normalizado);
}

module.exports = { esRutaSinLimiter };
