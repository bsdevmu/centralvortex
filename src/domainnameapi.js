'use strict';
const express = require('express');
const DomainNameApi = require('nodejs-dna');
const router = express.Router();
const buckets = new Map();
const allowedOrigins = new Set(String(process.env.DOMAIN_SEARCH_ALLOWED_ORIGINS || 'https://www.vortexgrid.com.br,https://vortexgrid.com.br').split(',').map(v => v.trim()).filter(Boolean));

function fail(res, status, message) {
  return res.status(status).json({ erro: message });
}
function parseDomain(value) {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(x => !x || x.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x))) return null;
  return { domain, name: labels[0], extension: labels.slice(1).join('.') };
}
function cors(req, res, next) {
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) return fail(res, 403, 'Origem não autorizada para consulta de domínios.');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Accept, Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
function rateLimit(req, res, next) {
  const now = Date.now(), key = req.ip || req.socket.remoteAddress || 'unknown';
  let b = buckets.get(key);
  if (!b || now - b.started >= 60000) { b = { started: now, count: 0 }; buckets.set(key, b); }
  if (++b.count > 25) {
    res.set('Retry-After', '60');
    return fail(res, 429, 'Muitas consultas em pouco tempo. Aguarde um minuto e tente novamente.');
  }
  if (buckets.size > 5000) for (const [ip, item] of buckets) if (now - item.started >= 60000) buckets.delete(ip);
  next();
}
function normalizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (['available', 'free'].includes(s)) return 'available';
  if (['notavailable', 'not available', 'unavailable', 'registered'].includes(s)) return 'unavailable';
  return 'unknown';
}
router.options('/api/domains/dna/availability', cors);
router.get('/api/domains/dna/availability', cors, rateLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const parsed = parseDomain(req.query.domain);
  if (!parsed) return fail(res, 400, 'Informe um domínio válido, como exemplo.com.br, sem subdomínios.');
  const resellerId = String(process.env.DOMAINNAMEAPI_RESELLER_ID || '').trim();
  const apiKey = String(process.env.DOMAINNAMEAPI_API_KEY || '').trim();
  const testMode = String(process.env.DOMAINNAMEAPI_TEST_MODE || 'true').toLowerCase() !== 'false';
  if (!resellerId || !apiKey) return fail(res, 503, 'A consulta DNA ainda não foi configurada no servidor.');
  try {
    const api = new DomainNameApi(resellerId, apiKey, { testMode, telemetry: false });
    const result = await api.CheckAvailability([parsed.name], [parsed.extension], 1);
    if (!Array.isArray(result)) {
      console.error('DomainNameAPI availability error:', result?.error?.Code || result?.result || 'unexpected-response');
      return fail(res, 502, 'O registrador não conseguiu confirmar a disponibilidade agora.');
    }
    const item = result.find(x =>
      String(x.DomainName || '').toLowerCase() === parsed.domain ||
      (String(x.DomainName || '').toLowerCase() === parsed.name && String(x.TLD || '').toLowerCase() === parsed.extension)
    );
    if (!item) return res.json({ domain: parsed.domain, status: 'unknown', available: false, testMode, message: 'O registrador não retornou um resultado conclusivo. Tente novamente mais tarde.' });
    const status = normalizeStatus(item.Status);
    const price = item.Price !== undefined && item.Price !== null && Number.isFinite(Number(item.Price)) ? Number(item.Price) : null;
    const messages = {
      available: 'O domínio parece estar disponível para registro. A disponibilidade e o preço serão confirmados novamente antes do pedido.',
      unavailable: 'O domínio não está disponível para registro neste momento.',
      unknown: 'O registrador não confirmou a disponibilidade. Tente novamente mais tarde.'
    };
    return res.json({ domain: parsed.domain, status, available: status === 'available', price, testMode, message: messages[status] });
  } catch (err) {
    console.error('DomainNameAPI availability error:', err?.name || err?.code || 'error');
    return fail(res, 502, 'O serviço de consulta está temporariamente indisponível.');
  }
});
module.exports = router;
