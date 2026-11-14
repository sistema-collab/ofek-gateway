// Saneo de headers de IP ENCENDIDO (GATEWAY_SANITIZE_IP_HEADERS=true).
// node --test corre cada archivo en su propio proceso, así que la env var
// seteada acá antes de requerir server.js no afecta a los otros tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HEADERS_IP_CLIENTE, saneoIpActivo, sanearHeadersIp } = require('../lib/clientIpHeaders');

test('saneoIpActivo: sólo el string exacto "true" lo activa', () => {
  assert.equal(saneoIpActivo({ GATEWAY_SANITIZE_IP_HEADERS: 'true' }), true);
  for (const valor of [undefined, '', 'false', '1', 'TRUE', 'True', 'yes', ' true']) {
    assert.equal(saneoIpActivo({ GATEWAY_SANITIZE_IP_HEADERS: valor }), false, `valor: ${JSON.stringify(valor)}`);
  }
  assert.equal(saneoIpActivo({}), false);
});

// proxyReq falso: mismo API (setHeader/removeHeader) que http.ClientRequest.
function proxyReqFalso(headers) {
  const map = new Map(Object.entries(headers));
  return {
    map,
    setHeader: (k, v) => map.set(k.toLowerCase(), v),
    removeHeader: (k) => map.delete(k.toLowerCase()),
  };
}

test('sanearHeadersIp: borra todos los headers de IP y deja XFF = req.ip', () => {
  const todos = Object.fromEntries(HEADERS_IP_CLIENTE.map((h) => [h, '6.6.6.6']));
  const proxyReq = proxyReqFalso({ ...todos, 'content-type': 'application/json', authorization: 'Bearer x' });
  sanearHeadersIp(proxyReq, { ip: '203.0.113.7' });
  assert.deepEqual(Object.fromEntries(proxyReq.map), {
    'content-type': 'application/json',
    authorization: 'Bearer x',
    'x-forwarded-for': '203.0.113.7',
  });
});

test('sanearHeadersIp: sin req.ip no inventa un XFF', () => {
  const proxyReq = proxyReqFalso({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6' });
  sanearHeadersIp(proxyReq, { ip: undefined });
  assert.deepEqual(Object.fromEntries(proxyReq.map), {});
});

// Integración: gateway real (server.js) contra un target falso que guarda
// los headers que recibe.
let target;
let gateway;
let base;
const recibidos = [];

const IPS = /forward|real-ip|client-ip|connecting/;
const headersDeIp = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => IPS.test(k)));

before(async () => {
  target = http.createServer((req, res) => {
    recibidos.push({ url: req.url, headers: req.headers });
    res.end('ok');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${target.address().port}`;
  process.env.TARGET_APP_URL = url;
  process.env.TARGET_ADMIN_URL = url;
  process.env.TARGET_API_URL = url;
  process.env.TARGET_MODULO_COBRANZA_URL = url;
  process.env.GATEWAY_SANITIZE_IP_HEADERS = 'true';

  const { app } = require('../server.js');
  gateway = app.listen(0, '127.0.0.1');
  await new Promise((r) => gateway.on('listening', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => target.close(r));
});

// "6.6.6.6" = lo que inventa el cliente; "203.0.113.7" = lo que agrega el
// edge de Railway al final (con trust proxy 1, eso es req.ip).
const SPOOF = {
  'x-forwarded-for': '6.6.6.6, 203.0.113.7',
  'x-real-ip': '5.5.5.5',
  forwarded: 'for=9.9.9.9',
  'cf-connecting-ip': '8.8.8.8',
  'true-client-ip': '7.7.7.7',
};

for (const path of ['/api/x', '/auth/login', '/admin/', '/modulos/cobranza/api/clientes', '/']) {
  test(`saneo activo (${path}): sólo llega XFF con la IP real`, async () => {
    recibidos.length = 0;
    const res = await fetch(`${base}${path}`, { headers: SPOOF });
    assert.equal(res.status, 200);
    assert.deepEqual(headersDeIp(recibidos[0].headers), { 'x-forwarded-for': '203.0.113.7' });
  });
}

test('saneo activo: cliente honesto llega con el mismo XFF que hoy', async () => {
  recibidos.length = 0;
  await fetch(`${base}/api/x`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(recibidos[0].headers['x-forwarded-for'], '203.0.113.7');
});

test('saneo activo: el webhook de Meta sigue llegando con firma y body intactos', async () => {
  recibidos.length = 0;
  const res = await fetch(`${base}/modulos/cobranza/webhooks/whatsapp`, {
    method: 'POST',
    headers: { ...SPOOF, 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=abc123' },
    body: '{"object":"whatsapp_business_account"}',
  });
  assert.equal(res.status, 200);
  assert.equal(recibidos[0].headers['x-hub-signature-256'], 'sha256=abc123');
  assert.deepEqual(headersDeIp(recibidos[0].headers), { 'x-forwarded-for': '203.0.113.7' });
});
