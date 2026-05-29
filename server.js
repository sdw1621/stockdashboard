'use strict';
const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── CORS & static ─────────────────────────────────── */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(__dirname));

/* ── Symbol config ─────────────────────────────────── */
const SYMBOLS = [
  { id: 'kospi',   sym: '^KS11',    name: 'KOSPI'  },
  { id: 'samsung', sym: '005930.KS', name: '삼성전자' },
  { id: 'lg',      sym: '066570.KS', name: 'LG전자'  },
  { id: 'tesla',   sym: 'TSLA',     name: 'Tesla'  },
];

/* ── Server-side cache (15 s TTL) ──────────────────── */
let cache     = {};
let cacheTime = 0;
const TTL     = 15_000;

/* ── Yahoo Finance fetcher ─────────────────────────── */
async function fetchYahoo(sym, range = '1d', interval = '2m') {
  const hosts = ['query1', 'query2'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url =
        `https://${host}.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(sym)}` +
        `?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;

      const { data } = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'application/json,*/*',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'Referer':         'https://finance.yahoo.com/',
        },
        timeout: 7_000,
      });
      return data;
    } catch (e) {
      lastErr = e;
      console.warn(`[${host}] ${sym} → ${e.message}`);
    }
  }
  throw lastErr;
}

/* ── 급등·급락 로그 ─────────────────────────────────── */
const SURGE_THRESHOLD = 1.5;        // % — 폰 알람 임계값
const SURGE_COOL_MS   = 5 * 60_000; // 5분 쿨다운
let surgeLog          = [];         // 미읽은 급등 이벤트
let prevPriceMap      = {};         // id → 직전 가격
let surgeCoolMap      = {};         // id → 마지막 알람 시각

function detectSurge(id, name, newPrice) {
  const prev = prevPriceMap[id];
  prevPriceMap[id] = newPrice;
  if (!prev || prev === newPrice) return;

  const chgPct = ((newPrice - prev) / prev) * 100;
  if (Math.abs(chgPct) < SURGE_THRESHOLD) return;

  const now = Date.now();
  if (surgeCoolMap[id] && now - surgeCoolMap[id] < SURGE_COOL_MS) return;
  surgeCoolMap[id] = now;

  const event = { id, name, price: newPrice, chgPct: +chgPct.toFixed(2), ts: now };
  surgeLog.push(event);
  console.log(`⚡  급${chgPct > 0 ? '등' : '락'} 감지: ${name} ${chgPct.toFixed(2)}%`);
}

/* ── Refresh all indices ───────────────────────────── */
async function refreshAll() {
  const now = Date.now();
  if (Object.keys(cache).length && now - cacheTime < TTL) return cache;

  const next = { ...cache };          // start with stale data as fallback

  await Promise.all(
    SYMBOLS.map(async ({ id, sym, name }) => {
      try {
        const raw  = await fetchYahoo(sym);
        const res  = raw?.chart?.result?.[0];
        if (!res) throw new Error('empty result');

        const meta = res.meta;
        const q    = res.indicators?.quote?.[0] ?? {};
        const ts   = res.timestamp ?? [];

        const history = ts
          .map((t, i) => ({
            time : t * 1000,
            value: q.close?.[i] ?? q.open?.[i] ?? null,
          }))
          .filter(p => p.value !== null && !Number.isNaN(p.value));

        const ohlcv = ts
          .map((t, i) => ({
            t: t * 1000,
            o: q.open?.[i]  ?? null,
            h: q.high?.[i]  ?? null,
            l: q.low?.[i]   ?? null,
            c: q.close?.[i] ?? null,
          }))
          .filter(p => p.c !== null && !Number.isNaN(p.c));

        next[id] = {
          current  : meta.regularMarketPrice,
          prevClose: meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice,
          open     : meta.regularMarketOpen  ?? history[0]?.value,
          high     : meta.regularMarketDayHigh,
          low      : meta.regularMarketDayLow,
          history,
          ohlcv,
        };

        detectSurge(id, name, meta.regularMarketPrice);   // ← 급등 감지
        console.log(`✅  ${name}: ${meta.regularMarketPrice.toFixed(2)}  (${history.length} pts)`);
      } catch (e) {
        console.error(`❌  ${name}: ${e.message}`);
        // keep whatever stale data exists — next[id] unchanged
      }
    })
  );

  cache     = next;
  cacheTime = now;
  return cache;
}

/* ── 급등 이벤트 폴링 엔드포인트 ──────────────────────── */
app.get('/api/surges', (req, res) => {
  const events  = [...surgeLog];
  surgeLog      = [];               // 읽은 후 클리어
  res.json({ ok: true, surges: events });
});

/* ── 히스토리 엔드포인트 ────────────────────────────── */
const RANGE_MAP = {
  '1h' : { range: '1d',  interval: '1m'  },
  '1d' : { range: '1d',  interval: '2m'  },
  '5d' : { range: '5d',  interval: '15m' },
  '1mo': { range: '1mo', interval: '60m' },
  '6mo': { range: '6mo', interval: '1d'  },
  '1y' : { range: '1y',  interval: '1d'  },
  '3y' : { range: '3y',  interval: '1wk' },
  '5y' : { range: '5y',  interval: '1wk' },
};

app.get('/api/history', async (req, res) => {
  const sym   = (req.query.sym   || '').trim();
  const range = (req.query.range || '1d').trim();
  if (!sym)            return res.status(400).json({ ok: false, error: 'sym 필요' });
  if (!RANGE_MAP[range]) return res.status(400).json({ ok: false, error: '잘못된 range' });

  const { range: r, interval: iv } = RANGE_MAP[range];
  try {
    const raw    = await fetchYahoo(sym, r, iv);
    const result = raw?.chart?.result?.[0];
    if (!result) throw new Error('데이터 없음');

    const meta = result.meta;
    const q    = result.indicators?.quote?.[0] ?? {};
    const ts   = result.timestamp ?? [];

    const history = ts
      .map((t, i) => ({
        time : t * 1000,
        value: q.close?.[i] ?? q.open?.[i] ?? null,
      }))
      .filter(p => p.value !== null && !Number.isNaN(p.value));

    const ohlcv = ts
      .map((t, i) => ({
        t: t * 1000,
        o: q.open?.[i]  ?? null,
        h: q.high?.[i]  ?? null,
        l: q.low?.[i]   ?? null,
        c: q.close?.[i] ?? null,
      }))
      .filter(p => p.c !== null && !Number.isNaN(p.c));

    res.json({
      ok: true,
      data: {
        sym, range,
        current : meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose ?? meta.previousClose,
        history,
        ohlcv,
      },
    });
    console.log(`📊  히스토리: ${sym} [${range}] → ${history.length}pts`);
  } catch (e) {
    console.warn(`📊  히스토리 실패: ${sym} [${range}] → ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── Single-symbol search endpoint ────────────────── */
app.get('/api/search', async (req, res) => {
  const sym = (req.query.sym || '').trim();
  if (!sym) return res.status(400).json({ ok: false, error: 'sym 파라미터 필요' });

  try {
    const raw    = await fetchYahoo(sym);
    const result = raw?.chart?.result?.[0];
    if (!result) throw new Error(`"${sym}" 심볼을 찾을 수 없습니다`);

    const meta     = result.meta;
    const q        = result.indicators?.quote?.[0] ?? {};
    const ts       = result.timestamp ?? [];
    const currency = meta.currency ?? '';
    const exchange = (meta.exchangeName || meta.fullExchangeName || '').toUpperCase();

    // 한국 거래소 판별: 통화 KRW, 거래소 KSC/KOE/KSE, 심볼 접미사 .KS/.KQ
    const isKR = currency === 'KRW' ||
                 ['KSC','KOE','KSE','KOSPI','KOSDAQ'].some(x => exchange.includes(x)) ||
                 /\.(KS|KQ)$/i.test(sym);

    const history = ts
      .map((t, i) => ({
        time : t * 1000,
        value: q.close?.[i] ?? q.open?.[i] ?? null,
      }))
      .filter(p => p.value !== null && !Number.isNaN(p.value));

    res.json({
      ok  : true,
      data: {
        sym       : sym.toUpperCase(),
        name      : meta.shortName || meta.longName || sym,
        currency,
        exchange  : meta.fullExchangeName || meta.exchangeName || '—',
        isKR,
        decimals  : isKR ? 0 : 2,
        current   : meta.regularMarketPrice,
        prevClose : meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice,
        open      : meta.regularMarketOpen ?? history[0]?.value,
        high      : meta.regularMarketDayHigh,
        low       : meta.regularMarketDayLow,
        history,
      },
    });
    console.log(`🔍  검색: ${sym} → ${meta.regularMarketPrice} (${isKR?'KR':'US'})`);
  } catch (e) {
    console.warn(`🔍  검색 실패: ${sym} → ${e.message}`);
    res.status(404).json({ ok: false, error: e.message });
  }
});

/* ── API route ─────────────────────────────────────── */
app.get('/api/quotes', async (req, res) => {
  try {
    const data = await refreshAll();
    res.json({ ok: true, data, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── Start ─────────────────────────────────────────── */
app.listen(PORT, async () => {
  console.log(`\n🚀  StockVision  →  http://localhost:${PORT}/`);
  console.log(`📡  API          →  http://localhost:${PORT}/api/quotes\n`);
  await refreshAll().catch(console.error);   // pre-warm cache
});
