// Cotação USD -> BRL leve com cache em disco (12h) e fallback offline (camada collect/, zero deps npm).
const https = require('https');
const path = require('path');
const { readJson, writeJson } = require('../infra/store');

const DEFAULT_USD_TO_BRL = 5.80;
const REFRESH_MS = 12 * 3600e3;

function fetchJson(url, timeoutMs = 4500) {
  return new Promise((resolve) => {
    try {
      const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'ai-hud/1.0' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let raw = '';
        res.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(null); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function defaultFetchUsdBrl() {
  const a = await fetchJson('https://economia.awesomeapi.com.br/json/last/USD-BRL');
  const bid = a && a.USDBRL && Number(a.USDBRL.bid);
  if (Number.isFinite(bid) && bid > 1 && bid < 30) return bid;

  const f = await fetchJson('https://api.frankfurter.app/latest?from=USD&to=BRL');
  const rate = f && f.rates && Number(f.rates.BRL);
  if (Number.isFinite(rate) && rate > 1 && rate < 30) return rate;

  return null;
}

function createFxTracker({ dataDir, config = {}, fetcher = defaultFetchUsdBrl, now = () => Date.now() } = {}) {
  const cacheFile = dataDir ? path.join(dataDir, 'fx-cache.json') : '';
  const configured = Number(config && config.usdToBrl);
  const fallbackRate = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_USD_TO_BRL;

  let state = {
    usdToBrl: fallbackRate,
    source: Number.isFinite(configured) && configured > 0 ? 'config' : 'fallback',
    updatedAt: 0,
  };

  if (cacheFile && !(Number.isFinite(configured) && configured > 0)) {
    const cached = readJson(cacheFile, null);
    if (cached && Number.isFinite(cached.usdToBrl) && cached.usdToBrl > 1 && cached.usdToBrl < 30) {
      state = {
        usdToBrl: cached.usdToBrl,
        source: 'cache',
        updatedAt: Number(cached.updatedAt) || 0,
      };
    }
  }

  let inflight = null;

  async function refresh(force = false) {
    if (Number.isFinite(configured) && configured > 0) return state;
    if (!force && state.updatedAt && now() - state.updatedAt < REFRESH_MS) return state;
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => fetcher())
      .then((rate) => {
        if (Number.isFinite(rate) && rate > 1 && rate < 30) {
          state = {
            usdToBrl: Math.round(rate * 100) / 100,
            source: 'live',
            updatedAt: now(),
          };
          if (cacheFile) {
            try { writeJson(cacheFile, state); } catch {}
          }
        }
        return state;
      })
      .catch(() => state)
      .finally(() => { inflight = null; });
    return inflight;
  }

  function start() {
    refresh(false);
    const t = setInterval(() => refresh(false), REFRESH_MS);
    if (t.unref) t.unref();
  }

  function view() {
    return { ...state };
  }

  return { view, refresh, start };
}

module.exports = { createFxTracker, DEFAULT_USD_TO_BRL };
