export const DASHBOARD_HTML: string = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ThrottleKit · Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg-base:       #0c0d12;
    --bg-surface:    #14151c;
    --bg-elevated:   #1a1b24;
    --bg-overlay:    rgba(22, 23, 32, 0.7);
    --text-primary:  #e8e6e3;
    --text-secondary:#8b8a8d;
    --text-muted:    #55545a;
    --accent-allow:  #34d399;
    --accent-deny:   #f87171;
    --accent-warn:   #fbbf24;
    --accent-info:   #60a5fa;
    --accent-brand:  #818cf8;
    --gradient-brand: linear-gradient(135deg, #818cf8, #34d399);
    --gradient-glow:  radial-gradient(ellipse at 50% 0%, rgba(129,140,248,0.08) 0%, transparent 70%);

    --type-hero:     3.5rem;
    --type-heading:  1.125rem;
    --type-body:     0.875rem;
    --type-caption:  0.75rem;
    --type-mono:     'JetBrains Mono', monospace;

    font-size: 16px;
  }
  html, body { height: 100%; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg-base);
    color: var(--text-primary);
    padding: 24px 32px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    position: relative;
  }

  /* ---- Container ---- */
  .container {
    max-width: 1440px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  /* ---- Noise Overlay ---- */
  body::after {
    content: '';
    position: fixed;
    inset: 0;
    opacity: 0.015;
    pointer-events: none;
    z-index: 9999;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-repeat: repeat;
    background-size: 256px 256px;
  }

  /* ---- Slide-Up Animation ---- */
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .anim-card {
    animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  /* ---- Pulse Animation ---- */
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.85); }
  }

  /* ---- Top Bar ---- */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 56px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    margin-bottom: 0;
    animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .logo {
    font-size: 1.25rem;
    letter-spacing: -0.02em;
    user-select: none;
  }
  .logo-throttle {
    font-weight: 600;
    color: var(--text-primary);
  }
  .logo-kit {
    font-weight: 700;
    color: var(--accent-brand);
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    display: inline-block;
    flex-shrink: 0;
    transition: background 0.3s ease;
  }
  .status-dot.active {
    background: var(--accent-allow);
    animation: pulse 2s ease-in-out infinite;
  }
  .status-label {
    font-size: var(--type-caption);
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  /* ---- Metric Cards ---- */
  .metrics {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr 0.8fr;
    gap: 16px;
  }

  .card {
    position: relative;
    background: var(--bg-surface);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 16px;
    padding: 20px 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 16px;
    right: 16px;
    height: 3px;
    border-radius: 0 0 3px 3px;
  }
  .card.total::before    { background: var(--accent-info); }
  .card.allowed::before  { background: var(--accent-allow); }
  .card.denied::before   { background: var(--accent-deny); }
  .card.rate::before     { background: var(--accent-warn); }

  .card-label {
    font-size: var(--type-caption);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  .card-value-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .card-value {
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .card.total .card-value {
    font-size: var(--type-hero);
  }
  .card:not(.total) .card-value {
    font-size: 2.25rem;
  }
  .card.rate .card-value {
    font-size: 2.25rem;
  }
  .card-sub {
    font-size: var(--type-caption);
    color: var(--text-muted);
    margin-top: 2px;
    line-height: 1.4;
  }

  /* Deny Rate - color based on value */
  .card.rate .card-value.rate-low    { color: var(--accent-allow); }
  .card.rate .card-value.rate-mid   { color: var(--accent-warn); }
  .card.rate .card-value.rate-high  { color: var(--accent-deny); }

  /* Circular progress ring */
  .progress-ring {
    flex-shrink: 0;
    display: block;
  }
  .ring-bg {
    stroke: rgba(255, 255, 255, 0.05);
  }
  .ring-fill {
    stroke: var(--accent-allow);
    transition: stroke-dashoffset 0.5s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.3s ease;
    stroke-linecap: round;
  }

  /* ---- Main Area ---- */
  .main {
    display: grid;
    grid-template-columns: 1.65fr 1fr;
    gap: 16px;
    min-height: 0;
  }

  /* ---- Chart Card (Hero) ---- */
  .chart-card {
    position: relative;
    background: var(--bg-surface);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    min-height: 380px;
    display: flex;
    flex-direction: column;
  }
  /* Ambient glow */
  .chart-card::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: 17px;
    background: var(--gradient-brand);
    opacity: 0.06;
    z-index: -1;
    filter: blur(20px);
    pointer-events: none;
  }
  .chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    flex-shrink: 0;
  }
  .chart-title {
    font-size: var(--type-heading);
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.3;
  }
  .chart-title span {
    font-weight: 400;
    color: var(--text-muted);
    font-size: var(--type-body);
  }
  .legend {
    display: flex;
    gap: 16px;
    font-size: var(--type-caption);
    color: var(--text-muted);
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .legend-dot.allow { background: var(--accent-allow); }
  .legend-dot.deny  { background: var(--accent-deny); }

  .chart-body {
    flex: 1;
    position: relative;
    min-height: 0;
    overflow: hidden;
  }
  .chart-body canvas {
    width: 100%;
    height: 100%;
    display: block;
  }

  /* Chart tooltip */
  .chart-tooltip {
    position: absolute;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease;
    background: var(--bg-elevated);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 8px 12px;
    font-family: var(--type-mono);
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--text-primary);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    z-index: 10;
    white-space: nowrap;
    min-width: 100px;
  }
  .chart-tooltip.visible {
    opacity: 1;
  }
  .chart-tooltip .tt-label {
    font-family: 'Inter', sans-serif;
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .chart-tooltip .tt-allow {
    color: var(--accent-allow);
  }
  .chart-tooltip .tt-deny {
    color: var(--accent-deny);
  }

  /* ---- Tables Column ---- */
  .tables-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }

  .table-card {
    flex: 1;
    background: var(--bg-surface);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 16px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .table-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 10px;
    flex-shrink: 0;
  }
  .table-scroll {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.06) transparent;
    margin: 0 -20px;
    padding: 0 20px;
  }
  .table-scroll::-webkit-scrollbar {
    width: 3px;
  }
  .table-scroll::-webkit-scrollbar-track {
    background: transparent;
  }
  .table-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  /* Data row */
  .data-row td {
    padding: 10px 0 4px 0;
    border-bottom: none;
    vertical-align: middle;
  }
  .data-row:first-child td {
    padding-top: 0;
  }

  /* Bar row */
  .bar-row td {
    padding: 0 0 6px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }
  .bar-row:last-child td {
    border-bottom: none;
  }

  /* Hover on data row */
  .data-row:hover td {
    background: transparent;
  }
  .data-row:hover + .bar-row td {
    background: rgba(255, 255, 255, 0.015);
  }

  /* Rank */
  .rank {
    width: 24px;
    text-align: center;
    font-size: var(--type-caption);
    font-weight: 500;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .rank-1 { color: var(--accent-warn); font-weight: 700; }
  .rank-2 { color: var(--text-secondary); font-weight: 600; }
  .rank-3 { color: #b87333; font-weight: 600; }

  /* Key name */
  .key-name {
    font-family: var(--type-mono);
    font-size: 0.8125rem;
    color: var(--text-primary);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 8px;
  }

  /* Count */
  .count {
    width: 80px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--text-primary);
    font-size: 0.8125rem;
    font-family: var(--type-mono);
  }

  /* Progress bars */
  .bar-track {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .bar-fill.g {
    background: linear-gradient(90deg, var(--accent-allow), #6ee7b7);
  }
  .bar-fill.r {
    background: linear-gradient(90deg, var(--accent-deny), #fca5a5);
  }

  .empty {
    padding: 24px 0;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--type-caption);
  }
  .empty-subtle {
    color: var(--text-muted);
    font-size: var(--type-caption);
    opacity: 0.4;
  }
  .empty-row td {
    padding-top: 2px !important;
    padding-bottom: 2px !important;
    border-bottom: none !important;
    text-align: center;
  }

  /* ---- Bottom Bar ---- */
  .bottombar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-surface);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 16px;
    padding: 12px 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: 0.25s;
  }
  .source-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .source-wrap label {
    font-size: var(--type-caption);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .source-wrap select {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: var(--type-caption);
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-elevated);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 6px 32px 6px 12px;
    cursor: pointer;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b8a8d' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    min-width: 120px;
    transition: border-color 0.15s ease, color 0.15s ease;
  }
  .source-wrap select:hover {
    border-color: rgba(255, 255, 255, 0.12);
    color: var(--text-primary);
  }
  .source-wrap select:focus {
    border-color: var(--accent-brand);
    color: var(--text-primary);
  }
  .bottombar-info {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: var(--type-caption);
    color: var(--text-muted);
  }
  .bottombar-info .refresh-info {
    font-family: var(--type-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
  }
  .instant-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: var(--type-caption);
    font-weight: 500;
    color: var(--text-muted);
    background: var(--bg-elevated);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 8px;
    padding: 5px 12px;
    cursor: pointer;
    transition: border-color .2s, color .2s, background .2s;
  }
  .instant-btn:hover {
    border-color: rgba(255,255,255,0.12);
    color: var(--text-secondary);
  }
  .instant-btn.active {
    border-color: rgba(96,165,250,0.3);
    color: var(--accent-info);
    background: rgba(96,165,250,0.08);
  }
  .instant-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-muted);
    transition: background .3s;
  }
  .instant-btn.active .instant-dot {
    background: var(--accent-info);
    box-shadow: 0 0 6px rgba(96,165,250,0.5);
    animation: instantPulse 1.5s ease-in-out infinite;
  }
  @keyframes instantPulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 4px rgba(96,165,250,0.4); }
    50% { opacity: 0.6; box-shadow: 0 0 8px rgba(96,165,250,0.7); }
  }

  /* ---- Responsive ---- */
  @media (max-width: 1100px) {
    .metrics {
      grid-template-columns: 1fr 1fr;
    }
    .main {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 640px) {
    body { padding: 16px; }
    .metrics {
      grid-template-columns: 1fr;
    }
    .topbar { height: auto; padding-bottom: 12px; }
    .card-value { font-size: 1.75rem !important; }
    .card.total .card-value { font-size: 2.25rem !important; }
    .bottombar { flex-direction: column; gap: 8px; align-items: flex-start; }
  }
</style>
</head>
<body>

<div class="container">

<!-- Top Bar -->
<header class="topbar">
  <div class="logo">
    <span class="logo-throttle">Throttle</span><span class="logo-kit">Kit</span>
  </div>
  <div class="topbar-right">
    <div class="status-group">
      <span class="status-dot" id="statusDot"></span>
      <span class="status-label" id="statusLabel">Connecting</span>
    </div>
  </div>
</header>

<!-- Metrics -->
<section class="metrics">
  <div class="card total anim-card" style="animation-delay:0.05s">
    <div class="card-label">Total Requests</div>
    <div class="card-value" id="totalRequests">0</div>
    <div class="card-sub">all time</div>
  </div>
  <div class="card allowed anim-card" style="animation-delay:0.10s">
    <div class="card-label">Allowed</div>
    <div class="card-value" id="allowedCount">0</div>
    <div class="card-sub">rate limit passed</div>
  </div>
  <div class="card denied anim-card" style="animation-delay:0.15s">
    <div class="card-label">Denied</div>
    <div class="card-value" id="deniedCount">0</div>
    <div class="card-sub">rate limit exceeded</div>
  </div>
  <div class="card rate anim-card" style="animation-delay:0.20s">
    <div class="card-label">Deny Rate</div>
    <div class="card-value-wrap">
      <span class="card-value" id="denyRate">0%</span>
      <svg class="progress-ring" width="48" height="48" viewBox="0 0 48 48">
        <circle class="ring-bg" cx="24" cy="24" r="20" fill="none" stroke-width="4" />
        <circle class="ring-fill" id="denyRing" cx="24" cy="24" r="20" fill="none" stroke-width="4"
          stroke-dasharray="125.66" stroke-dashoffset="125.66" transform="rotate(-90 24 24)" />
      </svg>
    </div>
    <div class="card-sub" id="denyRateSub">of requests denied</div>
  </div>
</section>

<!-- Main Area -->
<div class="main">
  <!-- Chart Card -->
  <div class="chart-card anim-card" style="animation-delay:0.12s">
    <div class="chart-header">
      <span class="chart-title">Traffic <span>(60s)</span></span>
      <div class="legend">
        <span class="legend-item"><span class="legend-dot allow"></span> Allowed</span>
        <span class="legend-item"><span class="legend-dot deny"></span> Denied</span>
      </div>
    </div>
    <div class="chart-body">
      <canvas id="chart"></canvas>
      <div class="chart-tooltip" id="chartTooltip">
        <div class="tt-label" id="ttLabel">-30s</div>
        <div class="tt-allow" id="ttAllow">Allow: 0</div>
        <div class="tt-deny" id="ttDeny">Deny: 0</div>
      </div>
    </div>
  </div>

  <!-- Tables Column -->
  <div class="tables-col">
    <div class="table-card anim-card" style="animation-delay:0.16s">
      <div class="table-title">Top Requested</div>
      <div class="table-scroll">
        <table>
          <tbody id="reqBody"><tr><td colspan="3"><div class="empty">Waiting for data</div></td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="table-card anim-card" style="animation-delay:0.20s">
      <div class="table-title">Top Denied</div>
      <div class="table-scroll">
        <table>
          <tbody id="denyBody"><tr><td colspan="3"><div class="empty">Waiting for data</div></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- Bottom Bar -->
<footer class="bottombar">
  <div class="source-wrap">
    <label for="srcSelect">Source</label>
    <select id="srcSelect"></select>
  </div>
  <div class="bottombar-info">
    <span id="lastUpd">Last update: —</span>
    <span class="refresh-info" id="refreshRate"></span>
  </div>
  <button class="instant-btn" id="instantBtn" title="Toggle instant updates">
    <span class="instant-dot" id="instantDot"></span>
    <span id="instantLabel">Animated</span>
  </button>
</footer>

</div>

<script>
(function () {
  'use strict';

  /* ---- Constants ---- */
  var MAX = 60;

  /* ---- State ---- */
  var allowHist = new Array(MAX + 1).fill(0);
  var denyHist  = new Array(MAX + 1).fill(0);
  var last = { total: 0, allowed: 0, denied: 0, denyRate: 0 };
  var lastUpd = null;
  var lastMsg = null; // stores last full message for source switch
  var ws = null;
  var rt = null;
  var mouseX = -1;
  var isHovering = false;
  var instantMode = false;

  var maxDisplay = 1;
  var lastMessageTime = Date.now();
  var messageInterval = 1000;

  /* ---- DOM refs ---- */
  var $ = function (id) { return document.getElementById(id); };
  var statusDot    = $('statusDot');
  var statusLabel  = $('statusLabel');
  var srcSelect    = $('srcSelect');
  var totalEl      = $('totalRequests');
  var allowEl      = $('allowedCount');
  var denyEl       = $('deniedCount');
  var rateEl       = $('denyRate');
  var rateSub      = $('denyRateSub');
  var denyRing     = $('denyRing');
  var canvas       = $('chart');
  var reqBody      = $('reqBody');
  var denyBody     = $('denyBody');
  var lastUpdEl    = $('lastUpd');
  var refreshRate  = $('refreshRate');
  var chartTooltip = $('chartTooltip');
  var ttLabel      = $('ttLabel');
  var ttAllow      = $('ttAllow');
  var ttDeny       = $('ttDeny');
  var instantBtn   = $('instantBtn');
  var instantDot   = $('instantDot');
  var instantLabel = $('instantLabel');

  /* ---- Counter Animation ---- */
  function animateValue(el, start, end, dur) {
    var range = end - start;
    var t0 = performance.now();
    function step(now) {
      var p = Math.min((now - t0) / dur, 1);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.floor(start + range * e).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---- Chart Drawing ---- */

  // Smooth quadratic bezier line with optional gradient fill
  function drawSmoothLine(ctx, points, color, fillColor, chartH, drawLen) {
    if (points.length < 2) return;
    var len = drawLen !== undefined ? Math.min(points.length, Math.max(2, drawLen)) : points.length;
    var pts = points.slice(0, len);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[Math.min(pts.length - 1, i + 2)];
      var cp1x = p1.x + (p2.x - p0.x) / 6;
      var cp1y = p1.y + (p2.y - p0.y) / 6;
      var cp2x = p2.x - (p3.x - p1.x) / 6;
      var cp2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    if (fillColor) {
      ctx.lineTo(pts[pts.length - 1].x, chartH);
      ctx.lineTo(pts[0].x, chartH);
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, 0, 0, chartH);
      grad.addColorStop(0, fillColor);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  function drawChart(cvs, allowData, denyData, maxValParam, scrollProgress) {
    var ctx = cvs.getContext('2d');
    var rect = cvs.parentElement.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = rect.width;
    var h = Math.max(280, Math.min(500, rect.height || 280));
    cvs.width = w * dpr;
    cvs.height = h * dpr;
    cvs.style.width = w + 'px';
    cvs.style.height = h + 'px';
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    var maxVal = maxValParam !== undefined ? maxValParam : Math.max(1, Math.max.apply(null, allowData.concat(denyData)));

    // Padding
    var pad = { t: 16, b: 24, l: 40, r: 16 };
    var chartW = w - pad.l - pad.r;
    var chartH = h - pad.t - pad.b;

    // Horizontal grid lines (4 lines)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var gy = pad.t + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(w - pad.r, gy);
      ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var i = 0; i <= 4; i++) {
      var labelVal = Math.round(maxVal - (maxVal / 4) * i);
      var ly = pad.t + (chartH / 4) * i;
      ctx.fillText(labelVal.toLocaleString(), pad.l - 8, ly);
    }

    // X-axis labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var xLabels = ['-60s', '-45s', '-30s', '-15s', 'now'];
    for (var i = 0; i < xLabels.length; i++) {
      var lx = pad.l + (i / (xLabels.length - 1)) * chartW;
      ctx.fillText(xLabels[i], lx, h - pad.b + 6);
    }

    var stepW = chartW / (MAX - 1);
    var offsetX = scrollProgress * stepW;

    // Build point arrays
    function buildPoints(data) {
      var pts = [];
      for (var i = 0; i < data.length; i++) {
        var x = pad.l + i * stepW - offsetX;
        var y = pad.t + chartH - (data[i] / maxVal) * chartH;
        y = Math.max(pad.t, Math.min(h - pad.b, y));
        pts.push({ x: x, y: y });
      }
      return pts;
    }

    var allowPts = buildPoints(allowData);
    var denyPts  = buildPoints(denyData);

    // Clip rendering to the chart grid area so smooth scrolling is clean
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, chartW, chartH);
    ctx.clip();

    // Draw fills first (behind lines)
    drawSmoothLine(ctx, allowPts, 'transparent', 'rgba(52, 211, 153, 0.12)', pad.t + chartH);
    drawSmoothLine(ctx, denyPts, 'transparent', 'rgba(248, 113, 113, 0.12)', pad.t + chartH);

    // Draw lines on top
    drawSmoothLine(ctx, allowPts, '#34d399', null, pad.t + chartH);
    drawSmoothLine(ctx, denyPts, '#f87171', null, pad.t + chartH);

    ctx.restore();

    // Crosshair on hover
    if (isHovering && mouseX >= pad.l && mouseX <= pad.l + chartW) {
      var idx = Math.round((mouseX - pad.l + offsetX) / stepW);
      idx = Math.max(0, Math.min(allowData.length - 1, idx));

      if (idx < allowPts.length && allowPts[idx]) {
        var chX = allowPts[idx].x;
        var allowY = allowPts[idx].y;
        var denyY = denyPts[idx].y;

        // Dashed vertical line
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chX, pad.t);
        ctx.lineTo(chX, h - pad.b);
        ctx.stroke();
        ctx.restore();

        // Dots on lines
        ctx.beginPath();
        ctx.arc(chX, allowY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#34d399';
        ctx.fill();
        ctx.strokeStyle = '#0c0d12';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(chX, denyY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#f87171';
        ctx.fill();
        ctx.strokeStyle = '#0c0d12';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Update tooltip
        var secsAgo = Math.round((1 - (idx / MAX)) * 60);
        var timeLabel = secsAgo <= 0 ? 'now' : '-' + secsAgo + 's';

        ttLabel.textContent = timeLabel;
        ttAllow.textContent = 'Allow: ' + Math.round(allowData[idx]).toLocaleString();
        ttDeny.textContent  = 'Deny: '  + Math.round(denyData[idx]).toLocaleString();

        // Position tooltip
        var tooltipX = chX + 16;
        var tooltipY = Math.max(pad.t, denyY - 20);
        if (tooltipX + 120 > chartW + pad.l) {
          tooltipX = chX - 16 - 120;
        }
        chartTooltip.style.left = tooltipX + 'px';
        chartTooltip.style.top = tooltipY + 'px';
        chartTooltip.classList.add('visible');
      }
    } else {
      chartTooltip.classList.remove('visible');
    }
  }

  /* ---- Table Population ---- */
  function populate(tbody, items, cls) {
    if (!items || !items.length) {
      tbody.innerHTML = '<tr><td colspan="3"><div class="empty">No data</div></td></tr>';
      return;
    }
    var m = Math.max(1, Math.max.apply(null, items.map(function (x) { return x.count; })));
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var x = items[i];
      var pct = (x.count / m) * 100;
      var rankClass = 'rank';
      if (i === 0) rankClass += ' rank-1';
      else if (i === 1) rankClass += ' rank-2';
      else if (i === 2) rankClass += ' rank-3';
      html += '<tr class="data-row">' +
        '<td class="' + rankClass + '">' + (i + 1) + '</td>' +
        '<td class="key-name">' + esc(x.key) + '</td>' +
        '<td class="count">' + x.count.toLocaleString() + '</td>' +
        '</tr>' +
        '<tr class="bar-row"><td colspan="3">' +
        '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
        '</td></tr>';
    }
    // Show "no other entries" placeholder if few items
    if (items.length < 5) {
      html += '<tr class="empty-row"><td colspan="3"><span class="empty-subtle">' +
        (items.length === 0 ? 'No entries yet' : 'No other entries') + '</span></td></tr>';
    }
    tbody.innerHTML = html;
  }

  /* ---- HTML Escape ---- */
  function esc(s) {
    if (typeof s !== 'string') s = String(s);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---- Update Deny Rate Ring ---- */
  function updateDenyRing(rate) {
    var circumference = 2 * Math.PI * 20; // ≈ 125.66
    var offset = circumference * (1 - Math.min(rate, 1));
    denyRing.setAttribute('stroke-dashoffset', offset);

    // Color
    var color;
    if (rate < 0.05) {
      color = '#34d399';
      rateEl.className = 'card-value rate-low';
    } else if (rate < 0.25) {
      color = '#fbbf24';
      rateEl.className = 'card-value rate-mid';
    } else {
      color = '#f87171';
      rateEl.className = 'card-value rate-high';
    }
    denyRing.setAttribute('stroke', color);
  }

  /* ---- Main Update ---- */
  function update(data) {
    var prev = last;
    last = {
      total: data.total,
      allowed: data.allowed,
      denied: data.denied,
      denyRate: data.denyRate
    };

    var dur = instantMode ? 40 : 1200;
    animateValue(totalEl, prev.total, data.total, dur);
    animateValue(allowEl, prev.allowed, data.allowed, dur);
    animateValue(denyEl, prev.denied, data.denied, dur);

    var pct = (data.denyRate * 100).toFixed(1);
    rateEl.textContent = pct + '%';
    updateDenyRing(data.denyRate);

    if (data.denyRate < 0.05) {
      rateSub.textContent = 'healthy';
    } else if (data.denyRate < 0.25) {
      rateSub.textContent = 'elevated';
    } else {
      rateSub.textContent = 'critical';
    }

    populate(reqBody, data.topRequested || [], 'g');
    populate(denyBody, data.topDenied || [], 'r');

    // Track source in selector
    if (data.sourceName) {
      var found = false;
      for (var i = 0; i < srcSelect.options.length; i++) {
        if (srcSelect.options[i].value === data.sourceName) { found = true; break; }
      }
      if (!found) {
        var opt = document.createElement('option');
        opt.value = data.sourceName;
        opt.textContent = data.sourceName;
        srcSelect.appendChild(opt);
      }
    }

    lastUpd = Date.now();
    lastUpdEl.textContent = 'Last update: just now';
  }

  /* ---- Update timer ---- */
  setInterval(function () {
    if (lastUpd) {
      var s = Math.floor((Date.now() - lastUpd) / 1000);
      if (s < 60) {
        lastUpdEl.textContent = 'Last update: ' + s + 's ago';
      } else {
        lastUpdEl.textContent = 'Last update: ' + Math.floor(s / 60) + 'm ago';
      }
    }
  }, 1000);

  /* ---- Process a snapshot from a specific source ---- */
  function processSnapshot(snap) {
    if (!snap || !snap.snapshot) return;
    var s = snap.snapshot;
    s.sourceName = snap.name;

    var newAllow = s.allowed - last.allowed;
    var newDeny = s.denied - last.denied;

    // Prevent spike on first connection snapshot
    if (last.total === 0) {
      newAllow = 0;
      newDeny = 0;
    }

    allowHist.push(newAllow);
    denyHist.push(newDeny);
    if (allowHist.length > MAX + 1) allowHist.shift();
    if (denyHist.length > MAX + 1) denyHist.shift();

    update(s);
    lastMessageTime = Date.now();
  }

  /* ---- WebSocket ---- */
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function () {
      statusDot.className = 'status-dot active';
      statusLabel.textContent = 'Connected';
      if (rt) { clearTimeout(rt); rt = null; }
    };

    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type !== 'snapshot') return;
        lastMsg = msg;

        // Find source
        var snap = null;
        if (msg.sources && msg.sources.length) {
          if (srcSelect.value) {
            var idx = msg.sources.findIndex(function (s) { return s.name === srcSelect.value; });
            if (idx >= 0) snap = msg.sources[idx];
          }
          if (!snap) snap = msg.sources[0];
        }

        processSnapshot(snap);

        if (msg.interval) {
          messageInterval = msg.interval;
          refreshRate.textContent = (msg.interval / 1000).toFixed(1) + 's interval';
        }
      } catch (e) { /* ignore parse errors */ }
    };

    ws.onclose = function () {
      statusDot.className = 'status-dot';
      statusLabel.textContent = 'Disconnected';
      lastUpdEl.textContent = 'Last update: disconnected';
      if (rt) clearTimeout(rt);
      rt = setTimeout(function () { statusLabel.textContent = 'Reconnecting'; connect(); }, 2000);
    };

    ws.onerror = function () { /* handled by onclose */ };
  }

  /* ---- Source change handler ---- */
  srcSelect.addEventListener('change', function () {
    if (!lastMsg) return;
    
    // Clear history to prevent data bleed between sources
    allowHist = new Array(MAX + 1).fill(0);
    denyHist  = new Array(MAX + 1).fill(0);
    last = { total: 0, allowed: 0, denied: 0, denyRate: 0 };
    lastMessageTime = Date.now();

    // Re-process the last message with the new source
    var snap = null;
    if (lastMsg.sources && lastMsg.sources.length) {
      if (srcSelect.value) {
        var idx = lastMsg.sources.findIndex(function (s) { return s.name === srcSelect.value; });
        if (idx >= 0) snap = lastMsg.sources[idx];
      }
      if (!snap) snap = lastMsg.sources[0];
    }
    processSnapshot(snap);
  });

  /* ---- Instant mode toggle ---- */
  instantBtn.addEventListener('click', function () {
    instantMode = !instantMode;
    instantBtn.classList.toggle('active', instantMode);
    instantLabel.textContent = instantMode ? 'Instant' : 'Animated';
  });

  /* ---- Canvas mouse events for crosshair ---- */
  canvas.addEventListener('mousemove', function (e) {
    var rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    isHovering = true;
  });

  canvas.addEventListener('mouseleave', function () {
    isHovering = false;
    mouseX = -1;
  });

  /* ---- Resize handler ---- */
  var rtimer = null;
  window.addEventListener('resize', function () {
    if (rtimer) clearTimeout(rtimer);
    rtimer = setTimeout(function () {
      // Redrawn on the next frame of the animation loop
    }, 100);
  });

  /* ---- Animation Loop ---- */
  function tick() {
    var now = Date.now();
    var elapsed = now - lastMessageTime;
    var progress = instantMode ? 0 : Math.min(1, elapsed / messageInterval);

    // Interpolate maxVal (upper limit)
    var targetMax = Math.max(1, Math.max.apply(null, allowHist.concat(denyHist)));
    if (instantMode) {
      maxDisplay = targetMax;
    } else {
      maxDisplay += (targetMax - maxDisplay) * 0.1;
    }

    drawChart(canvas, allowHist, denyHist, maxDisplay, progress);
    requestAnimationFrame(tick);
  }

  /* ---- Initialize ---- */
  connect();
  tick();
})();
</script>
</body>
</html>`;
