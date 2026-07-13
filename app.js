/* ==========================================================================
   AEGISNEST TRADING — TERMINAL DASHBOARD
   Vanilla JS + GSAP. Drives a single 60-second master timeline:
     - Total Equity counter ($850.00 -> $1,400.00, linear)
     - Equity curve SVG line draw (stroke-dashoffset, linear)
     - Live Trade Ledger feed (staggered, eased entrances)
   The header clock runs on its own real-time setInterval, outside the
   master timeline, since it represents "now" rather than the simulated week.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------- Config ---------- */
  const TIMELINE_DURATION = 60; // seconds
  const EQUITY_START = 841.00;
  const EQUITY_END = 1403.57;
  const CHART_POINT_COUNT = 140;
  const CHART_SEED = 42; // fixed seed -> reproducible render, run to run
  const LEDGER_TRADE_COUNT = 16;
  const LEDGER_MAX_VISIBLE = 14;
  const ASSETS = ['EUR/USD', 'XAU/USD'];
  const EQUITY_REPAINT_INTERVAL_MS = 180; // slows the visible tick rate, not the timeline

  /* ---------- Utilities ---------- */

  // Deterministic PRNG (mulberry32) so the chart shape and trade sequence
  // are identical on every Puppeteer render.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function formatCurrency(value) {
    return `$${value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  function formatSignedCurrency(value) {
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${formatCurrency(Math.abs(value))}`;
  }

  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---------- Live Clock (independent of the master timeline) ---------- */

  function startClock() {
    const clockEl = document.getElementById('clock');
    if (!clockEl) return;

    function tick() {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      clockEl.textContent = `${hh}:${mm}:${ss}`;
    }

    tick(); // paint immediately, don't wait for the first interval tick
    setInterval(tick, 1000);
  }

  /* ---------- Total Equity Counter ---------- */

  function animateEquityCounter(masterTL) {
    const equityEl = document.getElementById('total-equity');
    const pnlEl = document.getElementById('weekly-pnl');
    const pnlMetric = pnlEl ? pnlEl.closest('.metric') : null;

    const counter = { value: EQUITY_START };
    let lastRepaint = 0;

    function paint() {
      if (equityEl) equityEl.textContent = formatCurrency(counter.value);

      if (pnlEl) {
        const pnl = counter.value - EQUITY_START;
        pnlEl.textContent = formatSignedCurrency(pnl);
        if (pnlMetric) pnlMetric.classList.toggle('metric--negative', pnl < 0);
      }
    }

    masterTL.to(
      counter,
      {
        value: EQUITY_END,
        duration: TIMELINE_DURATION,
        ease: 'none', // linear: steady passage of the trading week
        onUpdate: () => {
          // The tween itself still runs every frame — only the DOM repaint
          // is throttled, so the digits change in readable steps instead
          // of blurring past every 16ms.
          const now = performance.now();
          if (now - lastRepaint >= EQUITY_REPAINT_INTERVAL_MS) {
            lastRepaint = now;
            paint();
          }
        },
        onComplete: paint, // guarantee the exact final value lands, unthrottled
      },
      0
    );
  }

  /* ---------- Equity Curve Chart ---------- */

  function generateEquityCurveValues(pointCount, startValue, endValue, rng) {
    const values = new Array(pointCount);
    values[0] = startValue;
    const perStepDrift = (endValue - startValue) / (pointCount - 1);

    for (let i = 1; i < pointCount - 1; i++) {
      const noise = (rng() - 0.5) * Math.abs(perStepDrift) * 10;
      values[i] = values[i - 1] + perStepDrift + noise;
    }
    values[pointCount - 1] = endValue; // land exactly on the target
    return values;
  }

  function mapValuesToPoints(values, width, height, paddingY) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    return values.map((v, i) => ({
      x: (i / (values.length - 1)) * width,
      y: height - paddingY - ((v - min) / range) * (height - paddingY * 2),
    }));
  }

  // Smooths a point array into a cubic-bezier SVG path (Catmull-Rom conversion).
  function pointsToSmoothPath(points) {
    let d = `M${points[0].x},${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
    }
    return d;
  }

  function drawGridlines(svg, width, height, lineCount) {
    const svgNS = 'http://www.w3.org/2000/svg';
    for (let i = 1; i < lineCount; i++) {
      const y = (height / lineCount) * i;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', 0);
      line.setAttribute('x2', width);
      line.setAttribute('y1', y);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', 'rgba(255,255,255,0.05)');
      line.setAttribute('stroke-width', 1);
      svg.appendChild(line);
    }
  }

    function drawEquityChart(masterTL) {
    const svg = document.getElementById('equity-curve');
    if (!svg) return;

    const svgNS = 'http://www.w3.org/2000/svg';
    const width = 950;
    const height = 550;
    const paddingY = 40;

    // Gridlines sit behind the curve
    drawGridlines(svg, width, height, 4);

    const rng = mulberry32(CHART_SEED);
    const values = generateEquityCurveValues(CHART_POINT_COUNT, EQUITY_START, EQUITY_END, rng);
    const points = mapValuesToPoints(values, width, height, paddingY);
    const pathData = pointsToSmoothPath(points);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', readCssVar('--color-profit') || '#00FFA3');
    path.setAttribute('stroke-width', 3);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.classList.add('curve-line'); // Hooks into the CSS neon glow

    // Build the gradient fill shape
    const fillPathData = pathData + ` L${width},${height} L0,${height} Z`;
    const fillPath = document.createElementNS(svgNS, 'path');
    fillPath.setAttribute('d', fillPathData);
    fillPath.setAttribute('fill', 'url(#curve-gradient)');
    fillPath.style.opacity = 0; // Starts hidden

    svg.appendChild(fillPath);
    svg.appendChild(path);

    const pathLength = path.getTotalLength();
    path.style.strokeDasharray = pathLength;
    path.style.strokeDashoffset = pathLength;

    masterTL.to(
      path,
      {
        strokeDashoffset: 0,
        duration: TIMELINE_DURATION,
        ease: 'none',
      },
      0
    );
    
    // Fade in the gradient block
    masterTL.to(
      fillPath,
      {
        opacity: 1,
        duration: TIMELINE_DURATION,
        ease: 'none',
      },
      0
    );
  }


  /* ---------- Live Trade Ledger ---------- */

  function generateTrade(rng) {
    const asset = ASSETS[rng() < 0.55 ? 0 : 1];
    const action = rng() < 0.5 ? 'BUY' : 'SELL';
    const isProfit = rng() < 0.7; // mostly winning trades, occasional loss
    const magnitude = 4 + rng() * 38;
    const pnl = isProfit ? magnitude : -magnitude * 0.6;
    return { asset, action, pnl };
  }

  function buildLedgerItem(trade) {
    const li = document.createElement('li');
    li.className = 'ledger-item';

    const assetEl = document.createElement('span');
    assetEl.className = 'ledger-item__asset';
    assetEl.textContent = trade.asset;

    const actionEl = document.createElement('span');
    actionEl.className = `ledger-item__action ledger-item__action--${trade.action.toLowerCase()}`;
    actionEl.textContent = trade.action;

    const pnlEl = document.createElement('span');
    const isProfit = trade.pnl >= 0;
    pnlEl.className = `ledger-item__pnl ledger-item__pnl--${isProfit ? 'profit' : 'loss'}`;
    pnlEl.textContent = formatSignedCurrency(trade.pnl);

    li.append(assetEl, actionEl, pnlEl);
    return li;
  }

  // Adds a trade row at the top of the ledger. Uses a manual FLIP so existing
  // rows visibly settle downward instead of snapping, and the new row
  // fades in with a slide-up.
  function addTradeToLedger(trade) {
    const list = document.getElementById('ledger-list');
    if (!list) return;

    const existingItems = Array.from(list.children);
    const firstPositions = existingItems.map((el) => el.getBoundingClientRect());

    const li = buildLedgerItem(trade);
    list.insertBefore(li, list.firstChild);

    while (list.children.length > LEDGER_MAX_VISIBLE) {
      list.removeChild(list.lastChild);
    }

    existingItems.forEach((el, i) => {
      if (!el.isConnected) return; // dropped by the max-visible cap
      const lastRect = el.getBoundingClientRect();
      const deltaY = firstPositions[i].top - lastRect.top;
      if (deltaY) {
        gsap.fromTo(el, { y: deltaY }, { y: 0, duration: 0.5, ease: 'back.out(1.2)' });
      }
    });

    gsap.fromTo(
      li,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'back.out(1.2)' }
    );
  }

  function scheduleLedgerFeed(masterTL) {
    const rng = mulberry32(CHART_SEED + 1); // different stream than the chart
    const startBuffer = 2;
    const endBuffer = 2;
    const activeWindow = TIMELINE_DURATION - startBuffer - endBuffer;
    const slot = activeWindow / LEDGER_TRADE_COUNT;

    for (let i = 0; i < LEDGER_TRADE_COUNT; i++) {
      const time = startBuffer + i * slot + rng() * slot * 0.8;
      const trade = generateTrade(rng);
      masterTL.call(addTradeToLedger, [trade], time);
    }
  }

  /* ---------- Preview Scaling (browser preview only) ----------
     The dashboard is a fixed 1920x1080 frame for Puppeteer capture, not a
     responsive page. On a phone browser the layout renders near actual
     size, so the ledger column sits off-screen to the right until you
     scroll. This scales the whole frame down to fit whatever window it's
     actually sitting in, purely so it's visible while previewing.
     At exactly 1920px wide (i.e. Puppeteer's viewport) the scale is 1,
     so this has no effect on the captured video. */
  function fitPreviewToViewport() {
    const terminal = document.getElementById('terminal');
    if (!terminal) return;
    const scale = Math.min(1, window.innerWidth / 1080, window.innerHeight / 1920);
    terminal.style.zoom = scale;
  }

  /* ---------- Init ---------- */

  document.addEventListener('DOMContentLoaded', () => {
    startClock();
    fitPreviewToViewport();
    window.addEventListener('resize', fitPreviewToViewport);

    const masterTL = gsap.timeline();
    animateEquityCounter(masterTL);
    drawEquityChart(masterTL);
    scheduleLedgerFeed(masterTL);
  });
})();
