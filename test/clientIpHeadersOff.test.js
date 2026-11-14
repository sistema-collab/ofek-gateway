// Saneo de headers de IP APAGADO (default, sin GATEWAY_SANITIZE_IP_HEADERS):
// documenta que el comportamiento sigue siendo el anterior -- los headers
// de IP del cliente llegan tal cual al target.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let target;
let gateway;
let base;
const recibidos = [];

before(async () => {
  target = http.createServer((req, res) => {
    recibidos.push({ headers: req.headers });
    res.end('ok');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${target.address().port}`;
  process.env.TARGET_APP_URL = url;
  process.env.TARGET_ADMIN_URL = url;
  process.env.TARGET_API_URL = url;
  process.env.TARGET_MODULO_COBRANZA_URL = url;
  delete process.env.GATEWAY_SANITIZE_IP_HEADERS;

  const { app } = require('../server.js');
  gateway = app.listen(0, '127.0.0.1');
  await new Promise((r) => gateway.on('listening', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => target.close(r));
});

test('saneo apagado: los headers de IP del cliente llegan intactos (comportamiento anterior)', async () => {
  const enviados = {
    'x-forwarded-for': '6.6.6.6, 203.0.113.7',
    'x-real-ip': '5.5.5.5',
    forwarded: 'for=9.9.9.9',
    'cf-connecting-ip': '8.8.8.8',
    'true-client-ip': '7.7.7.7',
  };
  recibidos.length = 0;
  const res = await fetch(`${base}/api/x`, { headers: enviados });
  assert.equal(res.status, 200);
  for (const [header, valor] of Object.entries(enviados)) {
    assert.equal(recibidos[0].headers[header], valor, header);
  }
});
