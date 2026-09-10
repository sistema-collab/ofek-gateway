#!/usr/bin/env node
// Chequeo standalone para CI: valida el orden de las rutas del gateway sin
// levantar el servidor (server.js no llama a app.listen cuando se lo
// requiere en vez de correrlo directo -- ver require.main al final de ese
// archivo) y sin necesitar las env vars de targets de módulos configuradas
// (un módulo sin target queda con proxy: null, pero su prefijo sigue
// entrando al chequeo de orden igual).

try {
  require('../server.js');
  console.log('[check-route-order] OK: ninguna ruta tapa a otra definida despues.');
} catch (err) {
  console.error(`[check-route-order] FAIL: ${err.message}`);
  process.exit(1);
}
