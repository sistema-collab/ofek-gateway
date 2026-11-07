// Headers de IP que el gateway NO debe reenviar tal cual los manda el
// cliente: cualquiera puede escribir su propio X-Forwarded-For (o
// cualquiera de estos) y, si llega intacto a los servicios de atrás, un
// servicio que lea el PRIMER valor de XFF (ej. getClientIp de
// ofek-app-core, que alimenta la allowlist de IP del login y la auditoría)
// termina usando una IP elegida por el cliente.
//
// Con el saneo activo, el gateway borra todos estos y reenvía un único
// X-Forwarded-For con req.ip -- la IP real del cliente según `trust proxy`
// (server.js), o sea el valor que agregó el edge de Railway, no el que
// mandó el cliente.
const HEADERS_IP_CLIENTE = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
];

// Apagado por defecto: sólo se activa con GATEWAY_SANITIZE_IP_HEADERS
// exactamente igual a 'true'. Cualquier otro valor (o la variable ausente)
// deja el comportamiento anterior -- headers reenviados tal cual.
function saneoIpActivo(env = process.env) {
  return env.GATEWAY_SANITIZE_IP_HEADERS === 'true';
}

// Se llama desde el hook proxyReq de http-proxy-middleware, antes de que
// se manden los headers al target. Nunca loguea IPs.
function sanearHeadersIp(proxyReq, req) {
  for (const header of HEADERS_IP_CLIENTE) {
    proxyReq.removeHeader(header);
  }
  if (req.ip) {
    proxyReq.setHeader('x-forwarded-for', req.ip);
  }
}

module.exports = { HEADERS_IP_CLIENTE, saneoIpActivo, sanearHeadersIp };
