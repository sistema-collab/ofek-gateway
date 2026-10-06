const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { esRutaSinLimiter } = require('../lib/rateLimitExempt');

const WEBHOOK = '/modulos/cobranza/webhooks/whatsapp';

test('esRutaSinLimiter: sólo el path exacto del webhook (con o sin barra final)', () => {
  assert.equal(esRutaSinLimiter(WEBHOOK), true);
  assert.equal(esRutaSinLimiter(`${WEBHOOK}/`), true);
  assert.equal(esRutaSinLimiter(`${WEBHOOK}/otra`), false);
  assert.equal(esRutaSinLimiter(`${WEBHOOK}x`), false);
  assert.equal(esRutaSinLimiter('/modulos/cobranza/webhooks'), false);
  assert.equal(esRutaSinLimiter('/modulos/cobranza/api/clientes'), false);
  assert.equal(esRutaSinLimiter('/'), false);
});

// Target falso que hace de ofek-modulo-cobranza: guarda lo que recibe.
let target;
let gateway;
let base;
const recibidos = [];

before(async () => {
  target = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      recibidos.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.end('ok');
    });
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  process.env.TARGET_MODULO_COBRANZA_URL = `http://127.0.0.1:${target.address().port}`;

  const { app } = require('../server.js');
  gateway = app.listen(0, '127.0.0.1');
  await new Promise((r) => gateway.on('listening', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => target.close(r));
});

test('webhook: el body llega byte a byte al módulo, con la firma intacta y sin sesión', async () => {
  recibidos.length = 0;
  const crudo = Buffer.from('{ "entry" :[ {"id":"1"} ],\n  "object":"whatsapp_business_account" }');
  const res = await fetch(`${base}${WEBHOOK}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=abc123' },
    body: crudo,
  });
  assert.equal(res.status, 200);
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].url, WEBHOOK);
  assert.ok(recibidos[0].body.equals(crudo));
  assert.equal(recibidos[0].headers['x-hub-signature-256'], 'sha256=abc123');
});

test('webhook: GET de verificación llega con el query string completo', async () => {
  recibidos.length = 0;
  const qs = '?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=42';
  const res = await fetch(`${base}${WEBHOOK}${qs}`);
  assert.equal(res.status, 200);
  assert.equal(recibidos[0].url, `${WEBHOOK}${qs}`);
});

test('webhook: excluido del rate limiter; las rutas vecinas no', async () => {
  const webhook = await fetch(`${base}${WEBHOOK}`, { method: 'POST', body: '{}' });
  assert.equal(webhook.headers.get('ratelimit-limit'), null);

  const api = await fetch(`${base}/modulos/cobranza/api/health`);
  assert.equal(api.headers.get('ratelimit-limit'), '1000');

  const sub = await fetch(`${base}${WEBHOOK}/otra`);
  assert.equal(sub.headers.get('ratelimit-limit'), '1000');
});

test('webhook: más requests que el límite general (1000) y ninguno da 429', async () => {
  const estados = new Set();
  for (let i = 0; i < 1010; i += 101) {
    const lote = await Promise.all(
      Array.from({ length: 101 }, () => fetch(`${base}${WEBHOOK}`, { method: 'POST', body: '{}' }).then((r) => r.status)),
    );
    lote.forEach((s) => estados.add(s));
  }
  assert.deepEqual([...estados], [200]);
});
