import { createServer } from "node:http";

import { openDatabase } from "../db/database.ts";
import { loadCommerceDashboardSnapshot } from "./data.ts";

const dbPath = process.argv[2] ?? "data/commerce.sqlite";
const port = Number(process.argv[3] ?? process.env.COMMERCE_DASHBOARD_PORT ?? "4399");

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Dashboard port must be an integer from 1 to 65535.");
}

const database = openDatabase(dbPath);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>COSMO Commerce Control Room</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07090d;
      --surface: #0d1117;
      --surface-2: #111722;
      --surface-3: #151c28;
      --line: rgba(255,255,255,.08);
      --line-strong: rgba(255,255,255,.13);
      --text: #f5f7fb;
      --muted: #8e98aa;
      --muted-2: #677184;
      --accent: #7c9cff;
      --accent-soft: rgba(124,156,255,.12);
      --good: #63d59a;
      --good-soft: rgba(99,213,154,.11);
      --warn: #efc76f;
      --warn-soft: rgba(239,199,111,.11);
      --bad: #f17880;
      --bad-soft: rgba(241,120,128,.11);
      --shadow: 0 18px 60px rgba(0,0,0,.28);
    }

    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 10% -10%, rgba(77,101,170,.18), transparent 32rem),
        radial-gradient(circle at 100% 0%, rgba(64,83,126,.09), transparent 28rem),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    button, input, select { font: inherit; }
    a { color: inherit; }

    .app {
      width: min(1520px, calc(100% - 36px));
      margin: 0 auto;
      padding: 20px 0 64px;
    }

    .topbar {
      height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--line);
      margin-bottom: 34px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
      font-size: 13px;
      font-weight: 750;
      letter-spacing: -.01em;
    }

    .brand-mark {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, rgba(124,156,255,.24), rgba(124,156,255,.08));
      border: 1px solid rgba(124,156,255,.28);
      box-shadow: inset 0 1px rgba(255,255,255,.08);
      color: #dfe7ff;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: .08em;
    }

    .brand-sub {
      color: var(--muted-2);
      font-weight: 550;
      margin-left: 4px;
    }

    .top-status {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: rgba(255,255,255,.025);
      font-size: 11px;
      font-weight: 650;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--good);
      box-shadow: 0 0 0 4px rgba(99,213,154,.08);
    }

    .hero {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 28px;
    }

    .kicker {
      color: var(--accent);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .18em;
      font-weight: 800;
      margin-bottom: 10px;
    }

    h1 {
      margin: 0;
      font-size: clamp(31px, 4vw, 50px);
      line-height: .98;
      letter-spacing: -.05em;
      font-weight: 790;
    }

    .hero-copy {
      margin-top: 13px;
      max-width: 720px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
    }

    .authority {
      flex: 0 0 auto;
      min-width: 250px;
      border: 1px solid var(--line);
      border-radius: 15px;
      background: rgba(13,17,23,.72);
      padding: 13px 15px;
      box-shadow: var(--shadow);
    }

    .authority-label {
      color: var(--muted-2);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .16em;
      font-weight: 800;
    }

    .authority-value {
      margin-top: 5px;
      font-size: 12px;
      color: #d9dfeb;
      font-weight: 650;
    }

    .primary-kpis {
      display: grid;
      grid-template-columns: 1.3fr 1fr 1fr 1fr;
      gap: 12px;
      margin-bottom: 12px;
    }

    .kpi {
      position: relative;
      min-height: 124px;
      padding: 18px 19px;
      border: 1px solid var(--line);
      border-radius: 17px;
      background: linear-gradient(180deg, rgba(18,24,34,.95), rgba(12,16,23,.95));
      box-shadow: 0 12px 35px rgba(0,0,0,.13);
      overflow: hidden;
    }

    .kpi.featured {
      background:
        radial-gradient(circle at 90% 10%, rgba(124,156,255,.14), transparent 12rem),
        linear-gradient(180deg, rgba(19,25,38,.98), rgba(12,16,23,.98));
      border-color: rgba(124,156,255,.2);
    }

    .kpi-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .12em;
      font-weight: 750;
    }

    .kpi-value {
      margin-top: 12px;
      font-size: 32px;
      font-weight: 790;
      letter-spacing: -.04em;
    }

    .kpi-note {
      margin-top: 5px;
      color: var(--muted-2);
      font-size: 11px;
    }

    .secondary-kpis {
      display: flex;
      gap: 1px;
      padding: 1px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--line);
      overflow: hidden;
      margin-bottom: 26px;
    }

    .mini-kpi {
      flex: 1;
      min-width: 0;
      background: var(--surface);
      padding: 12px 14px;
    }

    .mini-label {
      color: var(--muted-2);
      font-size: 9px;
      letter-spacing: .1em;
      text-transform: uppercase;
      font-weight: 750;
    }

    .mini-value {
      margin-top: 4px;
      font-size: 15px;
      font-weight: 720;
      color: #dce2ed;
    }

    .workspace {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(11,15,21,.84);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .workspace-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 19px;
      border-bottom: 1px solid var(--line);
    }

    .section-title {
      font-size: 14px;
      font-weight: 760;
      letter-spacing: -.015em;
    }

    .section-sub {
      margin-top: 3px;
      color: var(--muted-2);
      font-size: 11px;
    }

    .filters {
      display: grid;
      grid-template-columns: minmax(220px, 360px) 155px 155px 155px;
      gap: 8px;
      align-items: center;
    }

    input, select {
      width: 100%;
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,.025);
      color: #dce2ed;
      outline: none;
      padding: 0 11px;
      font-size: 11px;
      transition: border-color .15s ease, background .15s ease;
    }

    input::placeholder { color: #596274; }
    input:focus, select:focus {
      border-color: rgba(124,156,255,.45);
      background: rgba(124,156,255,.045);
    }

    .table-head {
      display: grid;
      grid-template-columns: minmax(270px, 2.2fr) .82fr .78fr .72fr .82fr .88fr .9fr 34px;
      gap: 14px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--line);
      color: var(--muted-2);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .11em;
      font-weight: 800;
    }

    .rows { display: grid; }

    .product {
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.008);
      transition: background .14s ease;
    }

    .product:last-child { border-bottom: 0; }
    .product:hover { background: rgba(255,255,255,.018); }

    .product-row {
      display: grid;
      grid-template-columns: minmax(270px, 2.2fr) .82fr .78fr .72fr .82fr .88fr .9fr 34px;
      gap: 14px;
      align-items: center;
      min-height: 72px;
      padding: 12px 18px;
      cursor: pointer;
    }

    .product-name {
      font-size: 13px;
      line-height: 1.35;
      font-weight: 720;
      letter-spacing: -.01em;
      color: #eef1f7;
    }

    .product-meta {
      margin-top: 4px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      color: var(--muted-2);
      font-size: 10px;
    }

    .dotsep::before {
      content: "·";
      margin-right: 6px;
      color: #465064;
    }

    .cell-label {
      display: none;
      color: var(--muted-2);
      text-transform: uppercase;
      letter-spacing: .09em;
      font-size: 8px;
      font-weight: 800;
      margin-bottom: 3px;
    }

    .cell-value {
      color: #dbe1ec;
      font-size: 12px;
      font-weight: 650;
    }

    .cell-muted {
      color: var(--muted);
      font-size: 10px;
      margin-top: 2px;
    }

    .score-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .score-bar {
      width: 42px;
      height: 4px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(255,255,255,.07);
    }

    .score-fill {
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 8px;
      border-radius: 7px;
      border: 1px solid var(--line);
      font-size: 9px;
      font-weight: 820;
      letter-spacing: .055em;
      white-space: nowrap;
    }

    .badge.INVESTIGATE, .badge.BUY_SMALL {
      color: #86e4b3;
      border-color: rgba(99,213,154,.18);
      background: var(--good-soft);
    }

    .badge.HOLD, .badge.WATCH {
      color: #efd28f;
      border-color: rgba(239,199,111,.18);
      background: var(--warn-soft);
    }

    .badge.REJECT, .badge.BLOCKED, .badge.DO_NOT_STOCK {
      color: #f7959c;
      border-color: rgba(241,120,128,.18);
      background: var(--bad-soft);
    }

    .badge.UNEVALUATED {
      color: #aeb7c7;
      background: rgba(255,255,255,.04);
    }

    .chevron {
      width: 27px;
      height: 27px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: var(--muted-2);
      background: rgba(255,255,255,.025);
      border: 1px solid transparent;
      font-size: 15px;
      transition: transform .16s ease, border-color .16s ease;
    }

    details[open] .chevron {
      transform: rotate(180deg);
      border-color: var(--line);
    }

    details > summary {
      list-style: none;
    }

    details > summary::-webkit-details-marker { display: none; }

    .drawer {
      border-top: 1px solid var(--line);
      background: rgba(7,10,15,.74);
      padding: 18px;
    }

    .drawer-grid {
      display: grid;
      grid-template-columns: 1.05fr 1fr 1fr 1.2fr;
      gap: 12px;
    }

    .detail-card {
      border: 1px solid var(--line);
      border-radius: 13px;
      background: rgba(255,255,255,.018);
      padding: 14px;
      min-width: 0;
    }

    .detail-title {
      margin-bottom: 12px;
      color: #c8d0de;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .12em;
      font-weight: 800;
    }

    .detail-line {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      min-height: 25px;
      border-bottom: 1px solid rgba(255,255,255,.045);
      padding: 5px 0;
    }

    .detail-line:last-child { border-bottom: 0; }

    .detail-key {
      color: var(--muted-2);
      font-size: 10px;
    }

    .detail-value {
      text-align: right;
      color: #dce2ed;
      font-size: 10px;
      font-weight: 650;
      overflow-wrap: break-word;
    }

    .metric-big {
      margin-bottom: 11px;
      font-size: 22px;
      letter-spacing: -.035em;
      font-weight: 780;
    }

    .metric-caption {
      margin-top: -7px;
      margin-bottom: 13px;
      color: var(--muted-2);
      font-size: 9px;
    }

    .pill-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .pill {
      padding: 5px 7px;
      border-radius: 6px;
      background: rgba(255,255,255,.035);
      border: 1px solid var(--line);
      color: #aeb7c7;
      font-size: 9px;
      line-height: 1.2;
    }

    .pill.bad {
      color: #ec9ca2;
      border-color: rgba(241,120,128,.13);
      background: rgba(241,120,128,.05);
    }

    .evidence-list {
      display: grid;
      gap: 7px;
      max-height: 180px;
      overflow: auto;
      padding-right: 4px;
    }

    .evidence {
      display: block;
      padding: 9px 10px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,.02);
      text-decoration: none;
      transition: border-color .15s ease, background .15s ease;
    }

    .evidence:hover {
      border-color: rgba(124,156,255,.3);
      background: rgba(124,156,255,.04);
    }

    .evidence-kind {
      color: var(--accent);
      font-size: 8px;
      font-weight: 850;
      letter-spacing: .1em;
    }

    .evidence-url {
      display: block;
      margin-top: 3px;
      color: #929cad;
      font-size: 9px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .empty {
      margin: 18px;
      min-height: 180px;
      display: grid;
      place-items: center;
      border: 1px dashed var(--line-strong);
      border-radius: 13px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }

    .footer {
      padding: 12px 18px;
      border-top: 1px solid var(--line);
      color: var(--muted-2);
      font-size: 9px;
    }

    .loading {
      padding: 56px 18px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 1180px) {
      .hero { align-items: flex-start; }
      .authority { display: none; }
      .primary-kpis { grid-template-columns: repeat(2, 1fr); }
      .secondary-kpis { display: grid; grid-template-columns: repeat(4, 1fr); }
      .filters { grid-template-columns: 1fr 1fr; }
      .table-head { display: none; }
      .product-row {
        grid-template-columns: minmax(240px, 1.7fr) 1fr 1fr 34px;
      }
      .product-row > div:nth-child(5),
      .product-row > div:nth-child(6),
      .product-row > div:nth-child(7) { display: none; }
      .drawer-grid { grid-template-columns: repeat(2, 1fr); }
    }

    @media (max-width: 720px) {
      .app {
        width: min(100% - 20px, 1520px);
        padding-top: 8px;
      }
      .topbar { margin-bottom: 24px; }
      .brand-sub, .top-status .status-chip:first-child { display: none; }
      .hero { margin-bottom: 20px; }
      h1 { font-size: 34px; }
      .hero-copy { font-size: 12px; }
      .primary-kpis { grid-template-columns: 1fr 1fr; }
      .kpi { min-height: 105px; padding: 15px; }
      .kpi-value { font-size: 27px; }
      .secondary-kpis { grid-template-columns: repeat(2, 1fr); }
      .workspace-head { align-items: flex-start; flex-direction: column; }
      .filters { width: 100%; grid-template-columns: 1fr; }
      .product-row {
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: start;
      }
      .product-row > div:not(:first-child):not(:last-child) { display: none; }
      .drawer-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">CO</div>
        <div>COSMO Commerce <span class="brand-sub">Control Room</span></div>
      </div>
      <div class="top-status">
        <div class="status-chip"><span class="status-dot"></span>Local database</div>
        <div class="status-chip">Research authority only</div>
      </div>
    </header>

    <section class="hero">
      <div>
        <div class="kicker">Product intelligence</div>
        <h1>Commerce Control Room</h1>
        <div class="hero-copy">
          One decision surface for buyer intent, marketplace demand, pricing, economics and stock strategy.
          Nothing here can purchase inventory or mutate a seller account.
        </div>
      </div>
      <aside class="authority">
        <div class="authority-label">Execution boundary</div>
        <div class="authority-value">Research → economics → recommendation</div>
        <div class="authority-value" style="color:var(--muted);font-weight:550;">Listing & purchasing remain locked</div>
      </aside>
    </section>

    <section class="primary-kpis" id="primary-kpis"></section>
    <section class="secondary-kpis" id="secondary-kpis"></section>

    <section class="workspace">
      <div class="workspace-head">
        <div>
          <div class="section-title">Product pipeline</div>
          <div class="section-sub">Latest research state and commercial recommendation per canonical product.</div>
        </div>
        <div class="filters">
          <input id="search" type="search" placeholder="Search product, category, intent…">
          <select id="recommendation">
            <option value="">All decisions</option>
            <option value="INVESTIGATE">Investigate</option>
            <option value="HOLD">Hold</option>
            <option value="REJECT">Reject</option>
            <option value="UNEVALUATED">Unevaluated</option>
          </select>
          <select id="marketplace">
            <option value="">All marketplaces</option>
            <option value="AMAZON_IN">Amazon India</option>
            <option value="FLIPKART_IN">Flipkart India</option>
          </select>
          <select id="stock">
            <option value="">All stock states</option>
            <option value="BUY_SMALL">Buy small</option>
            <option value="WATCH">Watch</option>
            <option value="DO_NOT_STOCK">Do not stock</option>
          </select>
        </div>
      </div>

      <div class="table-head">
        <div>Product</div>
        <div>Decision</div>
        <div>Market</div>
        <div>Demand</div>
        <div>Reference</div>
        <div>Target price</div>
        <div>Stock plan</div>
        <div></div>
      </div>

      <div class="rows" id="products">
        <div class="loading">Loading local commerce intelligence…</div>
      </div>
      <div class="footer" id="footer"></div>
    </section>
  </main>

  <script>
    let snapshot = null;

    const money = (paise) => {
      if (paise === null || paise === undefined) return "—";
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
      }).format(paise / 100);
    };

    const pct = (bps) => bps === null || bps === undefined
      ? "—"
      : (bps / 100).toFixed(1) + "%";

    const text = (value) => value === null || value === undefined || value === ""
      ? "—"
      : String(value);

    const escapeHtml = (value) => String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    const labelMarketplace = (value) => value === "AMAZON_IN"
      ? "Amazon"
      : value === "FLIPKART_IN"
        ? "Flipkart"
        : "—";

    const pretty = (value) => text(value)
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());

    function renderKpis() {
      const s = snapshot.summary;
      const primary = [
        ["Tracked products", s.totalProducts, "Canonical research subjects", true],
        ["Investigate", s.investigate, "Worth deeper commercial work", false],
        ["Buy small", s.buySmall, "Verified bounded pilot candidates", false],
        ["Listed", s.listed, "Already live / excluded from discovery", false]
      ];

      document.getElementById("primary-kpis").innerHTML = primary.map(
        ([label, value, note, featured]) =>
          '<div class="kpi' + (featured ? ' featured' : '') + '">' +
            '<div class="kpi-label">' + escapeHtml(label) + '</div>' +
            '<div class="kpi-value">' + escapeHtml(value) + '</div>' +
            '<div class="kpi-note">' + escapeHtml(note) + '</div>' +
          '</div>'
      ).join("");

      const secondary = [
        ["Evaluated", s.evaluatedProducts],
        ["Hold", s.hold],
        ["Rejected", s.reject],
        ["Stock watch", s.stockWatch]
      ];

      document.getElementById("secondary-kpis").innerHTML = secondary.map(
        ([label, value]) =>
          '<div class="mini-kpi">' +
            '<div class="mini-label">' + escapeHtml(label) + '</div>' +
            '<div class="mini-value">' + escapeHtml(value) + '</div>' +
          '</div>'
      ).join("");
    }

    function scoreHtml(value) {
      if (value === null || value === undefined) return "—";
      const safe = Math.max(0, Math.min(100, Number(value)));
      return '<div class="score-wrap"><div class="score-bar"><div class="score-fill" style="width:' +
        safe + '%"></div></div><span class="cell-value">' + escapeHtml(safe) + '</span></div>';
    }

    function detailLine(key, value) {
      return '<div class="detail-line"><span class="detail-key">' +
        escapeHtml(key) + '</span><span class="detail-value">' +
        escapeHtml(value) + '</span></div>';
    }

    function pillList(values, bad) {
      if (!values.length) return '<span class="pill">None</span>';
      return values.map((value) =>
        '<span class="pill' + (bad ? ' bad' : '') + '">' +
        escapeHtml(pretty(value)) + '</span>'
      ).join("");
    }

    function evidenceHtml(sources) {
      if (!sources.length) {
        return '<div class="cell-muted">No deep-research sources stored.</div>';
      }
      return '<div class="evidence-list">' + sources.map((source) =>
        '<a class="evidence" target="_blank" rel="noreferrer" href="' +
          escapeHtml(source.url) + '">' +
          '<span class="evidence-kind">' + escapeHtml(source.kind) + '</span>' +
          '<span class="evidence-url">' + escapeHtml(source.url) + '</span>' +
        '</a>'
      ).join("") + '</div>';
    }

    function productHtml(product) {
      const e = product.evaluation;
      const recommendation = e ? e.recommendation : "UNEVALUATED";
      const stockDecision = e ? (e.stockDecision ?? "WATCH") : "WATCH";
      const targetPrice = e ? (e.verifiedPricePaise ?? e.suggestedPricePaise) : null;
      const blockers = e ? e.blockingReasons : [];
      const economicsReasons = e ? e.economicsReasons : [];
      const sources = e ? e.sources : [];
      const risks = e
        ? Object.entries(e.risk).filter(([, active]) => active).map(([key]) => key)
        : [];

      const pricingCard =
        '<div class="detail-card">' +
          '<div class="detail-title">Unit economics</div>' +
          '<div class="metric-big">' + escapeHtml(money(targetPrice)) + '</div>' +
          '<div class="metric-caption">' + (e && e.netProfitVerified ? 'Verified target price' : 'Research-stage target price') + '</div>' +
          detailLine("Market reference", e ? money(e.marketReferencePricePaise) : "—") +
          detailLine("Supplier cost", e ? money(e.supplierCostPaise) : "—") +
          detailLine("Expected net profit", e ? money(e.expectedNetProfitPaise) : "—") +
          detailLine("Decision margin", e ? pct(e.decisionMarginBps) : "—") +
          detailLine("Cash ROI", e ? pct(e.cashRoiBps) : "—") +
          detailLine("Stress profit", e ? money(e.stressNetProfitPaise) : "—") +
        '</div>';

      const demandCard =
        '<div class="detail-card">' +
          '<div class="detail-title">Demand profile</div>' +
          '<div class="metric-big">' + escapeHtml(e ? text(e.demandScore) : "—") + '<span style="font-size:11px;color:var(--muted-2);font-weight:600;"> / 100</span></div>' +
          '<div class="metric-caption">' + escapeHtml(e ? pretty(e.demandClass ?? "unclassified") : "Not evaluated") + '</div>' +
          detailLine("Competition", e ? text(e.competitionScore) + " / 100" : "—") +
          detailLine("Trend confidence", e ? text(e.trendConfidence) + " / 100" : "—") +
          detailLine("Reactive", e ? text(e.demandReactive) : "—") +
          detailLine("Predictive", e ? text(e.demandPredictive) : "—") +
          detailLine("Structural", e ? text(e.demandStructural) : "—") +
        '</div>';

      const stockCard =
        '<div class="detail-card">' +
          '<div class="detail-title">Stock strategy</div>' +
          '<div class="metric-big"><span class="badge ' + escapeHtml(stockDecision) + '">' +
            escapeHtml(pretty(stockDecision)) + '</span></div>' +
          '<div class="metric-caption">Owner-approved pilot only</div>' +
          detailLine("Initial units", e ? text(e.recommendedStockUnits) : "0") +
          detailLine("Capital required", e ? money(e.stockCapitalPaise) : "—") +
          detailLine("Projected batch profit", e ? money(e.projectedBatchProfitPaise) : "—") +
          detailLine("Reorder point", e ? text(e.reorderPointUnits) + " units" : "—") +
          detailLine("Economics profile", e ? text(e.economicsProfileId) : "—") +
        '</div>';

      const evidenceCard =
        '<div class="detail-card">' +
          '<div class="detail-title">Evidence & controls</div>' +
          evidenceHtml(sources) +
          '<div class="detail-title" style="margin-top:14px;">Blockers</div>' +
          '<div class="pill-list">' + pillList(blockers, true) + '</div>' +
          '<div class="detail-title" style="margin-top:14px;">Economics reasons</div>' +
          '<div class="pill-list">' + pillList(economicsReasons, false) + '</div>' +
          '<div class="detail-title" style="margin-top:14px;">Risk flags</div>' +
          '<div class="pill-list">' + pillList(risks, true) + '</div>' +
        '</div>';

      return '<article class="product">' +
        '<details>' +
          '<summary class="product-row">' +
            '<div>' +
              '<div class="product-name">' + escapeHtml(product.title) + '</div>' +
              '<div class="product-meta">' +
                '<span>' + escapeHtml(product.category) + '</span>' +
                '<span class="dotsep">Intent ' + escapeHtml(text(product.commercialIntentScore)) + '</span>' +
                '<span class="dotsep">Urgency ' + escapeHtml(text(product.urgencyScore)) + '</span>' +
              '</div>' +
            '</div>' +
            '<div><div class="cell-label">Decision</div><span class="badge ' +
              escapeHtml(recommendation) + '">' + escapeHtml(pretty(recommendation)) + '</span></div>' +
            '<div><div class="cell-label">Market</div><div class="cell-value">' +
              escapeHtml(e ? labelMarketplace(e.marketplace) : "—") + '</div></div>' +
            '<div><div class="cell-label">Demand</div>' + scoreHtml(e ? e.demandScore : null) + '</div>' +
            '<div><div class="cell-label">Reference</div><div class="cell-value">' +
              escapeHtml(e ? money(e.marketReferencePricePaise) : "—") + '</div></div>' +
            '<div><div class="cell-label">Target price</div><div class="cell-value">' +
              escapeHtml(money(targetPrice)) + '</div><div class="cell-muted">' +
              escapeHtml(e && e.netProfitVerified ? "net verified" : "research") + '</div></div>' +
            '<div><div class="cell-label">Stock plan</div><span class="badge ' +
              escapeHtml(stockDecision) + '">' + escapeHtml(pretty(stockDecision)) + '</span></div>' +
            '<div class="chevron">⌄</div>' +
          '</summary>' +
          '<div class="drawer"><div class="drawer-grid">' +
            pricingCard + demandCard + stockCard + evidenceCard +
          '</div></div>' +
        '</details>' +
      '</article>';
    }

    function renderProducts() {
      const query = document.getElementById("search").value.trim().toLowerCase();
      const rec = document.getElementById("recommendation").value;
      const market = document.getElementById("marketplace").value;
      const stock = document.getElementById("stock").value;

      const products = snapshot.products.filter((product) => {
        const e = product.evaluation;
        const haystack = [
          product.title,
          product.category,
          product.intentId,
          product.productKey
        ].join(" ").toLowerCase();
        const recommendation = e ? e.recommendation : "UNEVALUATED";
        return (!query || haystack.includes(query)) &&
          (!rec || recommendation === rec) &&
          (!market || (e && e.marketplace === market)) &&
          (!stock || (e && e.stockDecision === stock));
      });

      document.getElementById("products").innerHTML = products.length
        ? products.map(productHtml).join("")
        : '<div class="empty"><div><strong>No matching products</strong><br><span style="color:var(--muted-2)">Change the filters to widen the pipeline.</span></div></div>';

      document.getElementById("footer").textContent =
        "Showing " + products.length + " of " + snapshot.products.length +
        " products · Local snapshot " + snapshot.generatedAt;
    }

    async function load() {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("Dashboard data request failed.");
      snapshot = await response.json();
      renderKpis();
      renderProducts();
    }

    for (const id of ["search", "recommendation", "marketplace", "stock"]) {
      document.getElementById(id).addEventListener(
        id === "search" ? "input" : "change",
        () => snapshot && renderProducts()
      );
    }

    load().catch((error) => {
      document.getElementById("products").innerHTML =
        '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
  </script>
</body>
</html>`

function jsonResponse(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );

  if (request.method !== "GET") {
    jsonResponse(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (url.pathname === "/health") {
    jsonResponse(response, 200, {
      ok: true,
      database: dbPath,
      transactionAuthority: false,
    });
    return;
  }

  if (url.pathname === "/api/dashboard") {
    try {
      jsonResponse(
        response,
        200,
        loadCommerceDashboardSnapshot(database),
      );
    } catch (error) {
      jsonResponse(response, 500, {
        error:
          error instanceof Error
            ? error.message
            : "dashboard_snapshot_failed",
      });
    }
    return;
  }

  if (url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    response.end(html);
    return;
  }

  jsonResponse(response, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `COSMO Commerce dashboard: http://127.0.0.1:${port}\nDatabase: ${dbPath}\n`,
  );
});

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
