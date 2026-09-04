const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

// Railway está delante como reverse proxy. Sin esto, req.ip (usado por el
// rate limiter y por cualquier log de IP) ve la IP interna de Railway en
// vez de la IP real del cliente.
app.set('trust proxy', 1);

// Headers de seguridad estándar (CSP, X-Frame-Options, X-Content-Type-Options, etc.)
// Se parte de los directives por defecto de Helmet y se pisa SOLO img-src,
// para permitir las fotos de perfil que el panel admin carga desde Supabase
// Storage (bucket de producción). El resto de las directivas (script-src,
// style-src, connect-src -> default-src, etc.) quedan igual que el default.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'img-src': ["'self'", 'data:', 'https://fuhtdaxaebzswkntkakx.supabase.co'],
      },
    },
  })
);

// Mismo handler para todos los limiters: 429 con JSON parejo.
function makeLimiter(max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: 'too many requests' });
    },
  });
}

// General: catch-all (TARGET_APP_URL) y moduleRoutes. Más permisivo porque
// incluye los assets estáticos que la SPA pide en cada visita.
const generalLimiter = makeLimiter(1000);

// /admin: superficie más sensible (panel de superadmin), límite propio más
// bajo que el general pero holgado para el uso normal del panel.
const adminLimiter = makeLimiter(200);

// Targets de los servicios internos de OFEK (Railway private networking).
const TARGET_APP_URL = process.env.TARGET_APP_URL || 'http://ofek-app-frontend.railway.internal:8080';
const TARGET_ADMIN_URL = process.env.TARGET_ADMIN_URL || 'http://ofek-admin-frontend.railway.internal:8080';
const TARGET_API_URL = process.env.TARGET_API_URL || 'http://ofek-app-core.railway.internal:8080';

const PROXY_TIMEOUT_MS = 30000;

function makeProxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    // Si el servicio interno no responde en este tiempo, cortar la
    // conexión en vez de dejarla colgada indefinidamente.
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    on: {
      // Loguear SOLO método, path y destino. Nunca loguear el header
      // Authorization (ni ningún otro header) ni el body del request.
      proxyReq: (proxyReq, req) => {
        console.log(`[gateway] ${req.method} ${req.originalUrl} -> ${target}`);
      },
      // El servicio interno está caído, no respondió a tiempo, o tiró un
      // error de conexión: no exponer el stack trace / mensaje crudo de
      // Node al cliente, responder un JSON genérico.
      error: (err, req, res) => {
        console.error(`[gateway] error proxeando ${req.method} ${req.originalUrl} -> ${target}: ${err.code || err.message}`);
        if (res.headersSent || res.writableEnded) {
          return res.end();
        }
        res.status(502).json({ error: 'servicio no disponible' });
      },
    },
  });
}

// NOTA: todo el montaje se hace con app.use(fn) SIN un path como primer
// argumento. Si se usara app.use('/admin', proxy), Express le saca el
// prefijo "/admin" a req.url antes de pasarlo al middleware, y el proxy
// terminaría reenviando el path recortado al target. Montando todo en la
// raíz y decidiendo la ruta "a mano" con req.path, req.url llega intacto
// (== req.originalUrl) hasta el proxy, así el target recibe el path completo.

// Config de proxies "directos": prefijo de path -> target. Para sumar un
// servicio nuevo alcanza con agregar una entrada acá. Si no se indica
// `limiter`, usa el general.
const proxyRoutes = [
  { prefix: '/admin', proxy: makeProxy(TARGET_ADMIN_URL), limiter: adminLimiter },
  // /auth y /api las consumen tanto el panel admin como el cliente logueado
  // (ej. /api/notificaciones), no son superficie exclusiva del panel -- van
  // con generalLimiter, igual que el catch-all. La fuerza bruta sobre login
  // puntualmente ya la frena el loginLimiter propio del backend
  // (ofek-app-core), esta es una capa extra, no la única.
  { prefix: '/auth', proxy: makeProxy(TARGET_API_URL), limiter: generalLimiter },
  { prefix: '/api', proxy: makeProxy(TARGET_API_URL), limiter: generalLimiter },
];

// Módulos de OFEK (ej: ofek-modulo-cobranza). Todavía no existen, así que
// cualquier módulo no listado acá responde 503. Cuando un módulo se
// despliegue, alcanza con agregar su entrada a este objeto.
const moduleRoutes = {
  // cobranza: makeProxy(process.env.TARGET_MODULO_COBRANZA_URL),
};

// ============================================================================
// TEMPORAL — SOLO PARA TESTING. ELIMINAR ESTA RUTA UNA VEZ VALIDADO QUE LA
// SESIÓN DE SUPABASE SE COMPARTE CORRECTAMENTE ENTRE LA APP PRINCIPAL Y LOS
// MÓDULOS BAJO /modulos/*. No es un caso real de moduleRoutes: es un caso
// especial exclusivo de /modulos/test, resuelto ANTES del middleware de
// proxies/módulos, así nunca cae en el 503 genérico de abajo.
// ============================================================================
app.get('/modulos/test', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Test sesión Supabase (TEMPORAL)</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 1.25rem; }
  .warn { background: #fff3cd; border: 1px solid #ffe69c; padding: 8px 12px; border-radius: 4px; font-size: 0.9rem; }
  ul { line-height: 1.6; }
</style>
</head>
<body>
<p class="warn">Ruta temporal de testing. No usar en producción.</p>
<h1>Test de sesión Supabase (/modulos/test)</h1>
<div id="resultado">Buscando sesión...</div>
<script src="/modulos/test.js"></script>
</body>
</html>`);
});

// Mismo bloque temporal: el JS de /modulos/test va aparte porque el CSP de
// Helmet (script-src 'self', sin unsafe-inline) bloquea <script> inline. Se
// sirve como archivo separado, con Content-Type application/javascript, para
// cumplir la política existente sin relajarla.
app.get('/modulos/test.js', (req, res) => {
  res.type('application/javascript').send(`(function () {
  function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return decodeURIComponent(atob(str).split('').map(function (c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
  }

  var resultado = document.getElementById('resultado');
  var tokenKey = 'ofek_access_token';
  var accessToken = localStorage.getItem(tokenKey);

  if (!accessToken) {
    resultado.innerHTML = '<p><strong>No se encontró sesión.</strong></p>';
    return;
  }

  try {
    var payload = JSON.parse(base64UrlDecode(accessToken.split('.')[1]));
    var expDate = payload.exp ? new Date(payload.exp * 1000).toLocaleString() : 'N/A';

    resultado.innerHTML =
      '<p><strong>Token encontrado</strong> (clave: ' + tokenKey + ')</p>' +
      '<ul>' +
      '<li><strong>sub (user id):</strong> ' + (payload.sub || 'N/A') + '</li>' +
      '<li><strong>exp:</strong> ' + expDate + '</li>' +
      '</ul>';
  } catch (e) {
    resultado.innerHTML = '<p><strong>Error parseando el token:</strong> ' + e.message + '</p>';
  }
})();
`);
});
// ============================================================================
// FIN RUTA TEMPORAL
// ============================================================================

const appProxy = makeProxy(TARGET_APP_URL);

function matchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

app.use((req, res, next) => {
  const route = proxyRoutes.find((r) => matchesPrefix(req.path, r.prefix));
  if (route) {
    return (route.limiter || generalLimiter)(req, res, () => route.proxy(req, res, next));
  }

  if (matchesPrefix(req.path, '/modulos')) {
    return generalLimiter(req, res, () => {
      const moduleName = req.path.split('/')[2];
      const moduleProxy = moduleRoutes[moduleName];

      if (moduleProxy) {
        return moduleProxy(req, res, next);
      }

      console.log(`[gateway] ${req.method} ${req.originalUrl} -> 503 (modulo no disponible aun)`);
      return res.status(503).json({ status: 'modulo no disponible aun' });
    });
  }

  // Catch-all: cualquier otro path (SPA de la app cliente, assets, etc.)
  return generalLimiter(req, res, () => appProxy(req, res, next));
});

app.listen(PORT, () => {
  console.log(`[gateway] ofek-gateway escuchando en puerto ${PORT}`);
  console.log(`[gateway] /admin/*    -> ${TARGET_ADMIN_URL}`);
  console.log(`[gateway] /auth/*     -> ${TARGET_API_URL}`);
  console.log(`[gateway] /api/*      -> ${TARGET_API_URL}`);
  console.log(`[gateway] /modulos/*  -> 503 (sin proxies configurados aun)`);
  console.log(`[gateway] /*          -> ${TARGET_APP_URL}`);
});
