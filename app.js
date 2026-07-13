/* ==========================================================================
   AEGISNEST TRADING — TERMINAL DASHBOARD
   Vanilla JS + GSAP. 
   Synchronized Timeline: Ledger, Chart, and Counter all pull from the same
   master trade array so math adds up exactly to the total P&L.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------- Config ---------- */
  const TIMELINE_DURATION = 60; 
  const EQUITY_START = 841.00;
  const EQUITY_END = 1403.57;
  const CHART_SEED = 42; 
  const LEDGER_TRADE_COUNT = 16;
  const LEDGER_MAX_VISIBLE = 14;
  const ASSETS = ['EUR/USD', 'XAU/USD'];

  // This will hold the synchronized data
  let masterTradesData = [];

  /* ---------- Utilities ---------- */
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

  /* ---------- Live Clock ---------- */
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

    tick();
    setInterval(tick, 1000);
  }

  /* ---------- Master Data Generation ---------- */
  // Distributes the exact total profit across the exact number of trades
  function generateMasterData() {
    const rng = mulberry32(CHART_SEED);
    const targetProfit = EQUITY_END - EQUITY_START;
    let rawSum = 0;

    masterTradesData = [];
    
    // Generate base weights for trades
    for (let i = 0; i < LEDGER_TRADE_COUNT; i++) {
      const isProfit = rng() < 0.65;
      const weight = (rng() * 40 + 10) * (isProfit ? 1 : -0.6);
      masterTradesData.push({
        asset: ASSETS[rng() < 0.5 ? 0 : 1],
        action: rng() < 0.5 ? 'BUY' : 'SELL',
        rawWeight: weight
      });
      rawSum += weight;
    }

    // Scale weights so they equal the exact target profit
    const scaleMultiplier = targetProfit / rawSum;
    let runningEquity = EQUITY_START;

    masterTradesData.forEach((trade, i) => {
      let pnl = trade.rawWeight * scaleMultiplier;
      pnl = Math.round(pnl * 100) / 100;
      
      // Force the final trade to absorb any rounding errors
      if (i === LEDGER_TRADE_COUNT - 1) {
        pnl = Math.round((EQUITY_END - runningEquity) * 100) / 100;
      }
      
      trade.pnl = pnl;
      runningEquity += pnl;
      trade.equityAfter = Math.round(runningEquity * 100) / 100;
    });
  }

  /* ---------- Total Equity Counter ---------- */
  function animateEquityCounter(masterTL) {
    const equityEl = document.getElementById('total-equity');
    const pnlEl = document.getElementById('weekly-pnl');
    const pnlMetric = pnlEl ? pnlEl.closest('.metric') : null;

    const counter = { value: EQUITY_START };

    function paint() {
      if (equityEl) equityEl.textContent = formatCurrency(counter.value);
      if (pnlEl) {
        const pnl = counter.value - EQUITY_START;
        pnlEl.textContent = formatSignedCurrency(pnl);
        if (pnlMetric) pnlMetric.classList.toggle('metric--negative', pnl < 0);
      }
    }

    paint();
    const segmentDuration = TIMELINE_DURATION / LEDGER_TRADE_COUNT;

    // Tween point-to-point so the number perfectly syncs with the trades
    masterTradesData.forEach((trade, i) => {
      masterTL.to(
        counter,
        {
          value: trade.equityAfter,
          duration: segmentDuration,
          ease: 'none',
          onUpdate: paint
        },
        i * segmentDuration
      );
    });
  }

  /* ---------- Equity Curve Chart ---------- */
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

  function drawEquityChart(masterTL) {
    const svg = document.getElementById('equity-curve');
    if (!svg) return;

    const svgNS = 'http://www.w3.org/2000/svg';
    const width = 950;
    const height = 550;
    const paddingY = 40;
    
        // Calculate dynamic boundaries to prevent the chart from clipping
    const allValues = [EQUITY_START, ...masterTradesData.map(t => t.equityAfter)];
    const highestPeak = Math.max(...allValues);
    const lowestValley = Math.min(...allValues);

    // Add a padding buffer and round to clean hundreds for the axis
    const maxVal = Math.ceil((highestPeak + 50) / 100) * 100; 
    const minVal = Math.floor((lowestValley - 50) / 100) * 100;
    const range = maxVal - minVal;


        // Draw Y-Axis (Prices from $800 to $1500)
    const levels = 5;
    for (let i = 0; i < levels; i++) {
      const price = maxVal - (range / (levels - 1)) * i;
      const yPos = paddingY + ((height - paddingY * 2) / (levels - 1)) * i;

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', 0);
      line.setAttribute('x2', width);
      line.setAttribute('y1', yPos);
      line.setAttribute('y2', yPos);
      line.setAttribute('stroke', 'rgba(255,255,255,0.05)');
      line.setAttribute('stroke-width', 1);
      svg.appendChild(line);

      const text = document.createElementNS(svgNS, 'text');
      
      // Short form currency logic
      if (price >= 1000) {
        text.textContent = '$' + parseFloat((price / 1000).toFixed(2)) + 'k';
      } else {
        text.textContent = '$' + Math.round(price);
      }

      text.setAttribute('x', width - 10);
      text.setAttribute('y', yPos - 8);
      text.setAttribute('text-anchor', 'end');
      text.setAttribute('class', 'chart-scale');
      svg.appendChild(text);
    }

    // Draw X-Axis (Days of the week)
    const days = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
    days.forEach((day, index) => {
      const text = document.createElementNS(svgNS, 'text');
      text.textContent = day;
      const xPos = index === 0 ? 0 : index === 4 ? width - 35 : (width / 4) * index - 15;
      text.setAttribute('x', xPos);
      text.setAttribute('y', height - 5);
      text.setAttribute('class', 'chart-scale');
      svg.appendChild(text);
    });

    // Map the synchronized trades directly to X/Y coordinates
    const points = [{
      x: 0,
      y: paddingY + ((height - paddingY * 2) / range) * (maxVal - EQUITY_START)
    }];

    masterTradesData.forEach((trade, i) => {
      const xPct = (i + 1) / LEDGER_TRADE_COUNT;
      const yPos = paddingY + ((height - paddingY * 2) / range) * (maxVal - trade.equityAfter);
      points.push({ x: xPct * width, y: yPos });
    });

    const pathData = pointsToSmoothPath(points);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', readCssVar('--color-profit') || '#00FFA3');
    path.setAttribute('stroke-width', 3);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.classList.add('curve-line'); 

    const fillPathData = pathData + ` L${width},${height} L0,${height} Z`;
    const fillPath = document.createElementNS(svgNS, 'path');
    fillPath.setAttribute('d', fillPathData);
    fillPath.setAttribute('fill', 'url(#curve-gradient)');
    fillPath.style.opacity = 0; 

    svg.appendChild(fillPath);
    svg.appendChild(path);

    const pathLength = path.getTotalLength();
    path.style.strokeDasharray = pathLength;
    path.style.strokeDashoffset = pathLength;

    masterTL.to(path, { strokeDashoffset: 0, duration: TIMELINE_DURATION, ease: 'none' }, 0);
    masterTL.to(fillPath, { opacity: 1, duration: TIMELINE_DURATION, ease: 'none' }, 0);
  }

  /* ---------- Live Trade Ledger ---------- */
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
      if (!el.isConnected) return; 
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
    const segmentDuration = TIMELINE_DURATION / LEDGER_TRADE_COUNT;
    masterTradesData.forEach((trade, i) => {
      // Trade appears exactly as the drawing line reaches that specific node
      const time = (i + 1) * segmentDuration;
      masterTL.call(addTradeToLedger, [trade], time);
    });
  }

      /* ---------- Preview Scaling ---------- */
  function fitPreviewToViewport() {
    const terminal = document.getElementById('terminal');
    if (!terminal) return;
    
    // Calculate the scale needed to fit the screen
    const scale = Math.min(1, window.innerWidth / 1080, window.innerHeight / 1920);
    
    // Translate pulls it back to true center, then scales it perfectly
    terminal.style.transform = `translate(-50%, -50%) scale(${scale})`;
    terminal.style.transformOrigin = 'center center';
  }

  /* ---------- Init ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    startClock();
    fitPreviewToViewport();
    window.addEventListener('resize', fitPreviewToViewport);

    generateMasterData();

    const masterTL = gsap.timeline();
    animateEquityCounter(masterTL);
    drawEquityChart(masterTL);
    scheduleLedgerFeed(masterTL);
  });
})();
         
