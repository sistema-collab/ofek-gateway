const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { matchesPrefix, checkRouteOrder } = require('./lib/routeOrder');

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
        'media-src': ["'self'", 'https://fuhtdaxaebzswkntkakx.supabase.co'],
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

// Módulos de OFEK (ej: ofek-modulo-cobranza). Para sumar un módulo nuevo
// alcanza con agregar su entrada acá con el nombre de la env var que va a
// tener su target -- el proxy real se arma en buildModuleProxies.
const moduleRoutesConfig = [
  // { prefix: '/modulos/cobranza', targetEnvVar: 'TARGET_MODULO_COBRANZA_URL' },
];

// Arma el proxy de cada módulo en un loop, con un try/catch POR ITERACIÓN
// (no uno solo alrededor de todo el loop): si a un módulo le falta la env
// var del target, o makeProxy() falla por lo que sea, esa entrada puntual
// queda con proxy: null y su ruta responde 503 más abajo -- un módulo mal
// configurado no puede tirar abajo el proceso entero.
function buildModuleProxies(routesConfig) {
  return routesConfig.map((route) => {
    try {
      const target = process.env[route.targetEnvVar];
      if (!target) {
        throw new Error(`falta configurar la variable de entorno ${route.targetEnvVar}`);
      }
      return { prefix: route.prefix, proxy: makeProxy(target) };
    } catch (err) {
      console.error(`[gateway] modulo ${route.prefix} no disponible: ${err.message}`);
      return { prefix: route.prefix, proxy: null };
    }
  });
}

const moduleRoutes = buildModuleProxies(moduleRoutesConfig);

// Orden real en que se evalúan los prefijos en el dispatch de abajo
// (proxyRoutes primero, después los módulos específicos, y por último el
// fallback genérico "/modulos" para cualquier módulo no listado). Si esto
// falla, el arranque se aborta -- ver lib/routeOrder.js.
const routePrefixesInOrder = [
  ...proxyRoutes.map((r) => r.prefix),
  ...moduleRoutes.map((r) => r.prefix),
  '/modulos',
];
checkRouteOrder(routePrefixesInOrder);

const allRoutes = [...proxyRoutes, ...moduleRoutes];

const appProxy = makeProxy(TARGET_APP_URL);

app.use((req, res, next) => {
  const route = allRoutes.find((r) => matchesPrefix(req.path, r.prefix));
  if (route) {
    const limiter = route.limiter || generalLimiter;

    if (!route.proxy) {
      return limiter(req, res, () => {
        console.log(`[gateway] ${req.method} ${req.originalUrl} -> 503 (modulo no disponible aun)`);
        res.status(503).json({ status: 'modulo no disponible aun' });
      });
    }

    return limiter(req, res, () => route.proxy(req, res, next));
  }

  if (matchesPrefix(req.path, '/modulos')) {
    return generalLimiter(req, res, () => {
      console.log(`[gateway] ${req.method} ${req.originalUrl} -> 503 (modulo no disponible aun)`);
      return res.status(503).json({ status: 'modulo no disponible aun' });
    });
  }

  // Catch-all: cualquier otro path (SPA de la app cliente, assets, etc.)
  return generalLimiter(req, res, () => appProxy(req, res, next));
});

// require.main !== module cuando este archivo se importa (ej. desde
// scripts/check-route-order.js) en vez de correrse directo -- así el
// chequeo de rutas de arriba se puede reusar sin levantar el server ni
// pedir un puerto.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[gateway] ofek-gateway escuchando en puerto ${PORT}`);
    console.log(`[gateway] /admin/*    -> ${TARGET_ADMIN_URL}`);
    console.log(`[gateway] /auth/*     -> ${TARGET_API_URL}`);
    console.log(`[gateway] /api/*      -> ${TARGET_API_URL}`);
    moduleRoutes.forEach((route) => {
      console.log(`[gateway] ${route.prefix}/* -> ${route.proxy ? 'proxy configurado' : '503 (no disponible)'}`);
    });
    console.log(`[gateway] /modulos/*  -> 503 (cualquier otro modulo no listado arriba)`);
    console.log(`[gateway] /*          -> ${TARGET_APP_URL}`);
  });
}

module.exports = { routePrefixesInOrder };
