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
  <title>COSMO Commerce Research</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b10;
      --panel: #11151d;
      --panel2: #171c26;
      --line: #252c39;
      --text: #f4f6fb;
      --muted: #939bad;
      --accent: #86a7ff;
      --good: #6fe0a8;
      --warn: #f4ca72;
      --bad: #ff858f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 15% -10%, rgba(87,116,201,.22), transparent 36rem),
        linear-gradient(180deg, #0c1017 0%, var(--bg) 45%);
      color: var(--text);
      min-height: 100vh;
    }
    .shell { max-width: 1440px; margin: 0 auto; padding: 36px 24px 70px; }
    .eyebrow { color: var(--accent); letter-spacing: .18em; font-size: 11px; font-weight: 800; }
    h1 { margin: 8px 0 8px; font-size: clamp(30px, 4vw, 48px); line-height: 1; letter-spacing: -.045em; }
    .sub { color: var(--muted); max-width: 780px; line-height: 1.55; }
    .notice {
      margin: 24px 0;
      padding: 14px 16px;
      border: 1px solid #3b3340;
      background: rgba(244,202,114,.07);
      color: #e8d9b4;
      border-radius: 14px;
      font-size: 13px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
      margin: 24px 0;
    }
    .stat {
      border: 1px solid var(--line);
      background: rgba(17,21,29,.82);
      border-radius: 16px;
      padding: 16px;
      min-height: 92px;
    }
    .stat span { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; }
    .stat strong { display: block; margin-top: 10px; font-size: 27px; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) 190px 190px;
      gap: 10px;
      margin: 18px 0;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 12px;
      padding: 12px 13px;
      outline: none;
    }
    input:focus, select:focus { border-color: #4c67a8; }
    .grid { display: grid; gap: 12px; }
    .product {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(23,28,38,.88), rgba(15,18,25,.94));
      border-radius: 18px;
      overflow: hidden;
    }
    .product-main {
      display: grid;
      grid-template-columns: 2.1fr .9fr .8fr .8fr .9fr .9fr;
      gap: 14px;
      padding: 17px 18px;
      align-items: center;
    }
    .name { font-size: 16px; font-weight: 750; letter-spacing: -.01em; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 5px; }
    .metric-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
    .metric-value { margin-top: 5px; font-size: 14px; font-weight: 700; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .07em;
      border: 1px solid var(--line);
    }
    .badge.INVESTIGATE { color: var(--good); background: rgba(111,224,168,.08); }
    .badge.HOLD { color: var(--warn); background: rgba(244,202,114,.08); }
    .badge.REJECT, .badge.BLOCKED { color: var(--bad); background: rgba(255,133,143,.08); }
    details { border-top: 1px solid var(--line); }
    summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 12px;
      padding: 11px 18px;
      list-style: none;
    }
    summary::-webkit-details-marker { display: none; }
    .detail {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 18px;
      padding: 4px 18px 18px;
    }
    .detail h3 { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin: 10px 0; }
    .pillrow { display: flex; gap: 6px; flex-wrap: wrap; }
    .pill { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 5px 8px; color: #c4cada; }
    .source { display: block; color: #a9bfff; font-size: 12px; text-decoration: none; margin: 7px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .source:hover { text-decoration: underline; }
    .empty { color: var(--muted); padding: 42px 18px; text-align: center; border: 1px dashed var(--line); border-radius: 18px; }
    .footer { color: #697184; font-size: 11px; margin-top: 20px; }
    @media (max-width: 1050px) {
      .stats { grid-template-columns: repeat(3, 1fr); }
      .product-main { grid-template-columns: 2fr 1fr 1fr; }
      .product-main > div:nth-child(n+4) { display: none; }
      .detail { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      .shell { padding: 24px 14px 50px; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .toolbar { grid-template-columns: 1fr; }
      .product-main { grid-template-columns: 1fr 1fr; }
      .product-main > div:nth-child(n+3) { display: none; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="eyebrow">COSMO · LOCAL COMMERCE</div>
    <h1>Research & Pricing Board</h1>
    <div class="sub">Buyer intent, product research, pricing strategy and evidence stored locally. Research only — no automatic listing, purchasing or marketplace mutation.</div>
    <div class="notice">Suggested prices are research-stage gross-price guidance. Net profit is not verified until current marketplace fees, taxes, shipping, returns and advertising costs are supplied to the economics engine.</div>

    <section class="stats" id="stats"></section>

    <section class="toolbar">
      <input id="search" type="search" placeholder="Search products, categories or intent…">
      <select id="recommendation">
        <option value="">All recommendations</option>
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
    </section>

    <section class="grid" id="products"></section>
    <div class="footer" id="footer"></div>
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

    const score = (value) => value === null || value === undefined
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

    function renderStats() {
      const s = snapshot.summary;
      const items = [
        ["Tracked", s.totalProducts],
        ["Evaluated", s.evaluatedProducts],
        ["Investigate", s.investigate],
        ["Hold", s.hold],
        ["Reject", s.reject],
        ["Listed", s.listed]
      ];
      document.getElementById("stats").innerHTML = items.map(([label, value]) =>
        '<div class="stat"><span>' + escapeHtml(label) + '</span><strong>' +
        escapeHtml(value) + '</strong></div>'
      ).join("");
    }

    function productHtml(product) {
      const e = product.evaluation;
      const recommendation = e ? e.recommendation : "UNEVALUATED";
      const strategy = e ? e.pricingStrategy : "—";
      const blockers = e ? e.blockingReasons : [];
      const sources = e ? e.sources : [];
      const risks = e
        ? Object.entries(e.risk).filter(([, active]) => active).map(([key]) => key)
        : [];

      return '<article class="product">' +
        '<div class="product-main">' +
          '<div><div class="name">' + escapeHtml(product.title) + '</div>' +
          '<div class="meta">' + escapeHtml(product.category) + ' · Intent ' +
          escapeHtml(product.commercialIntentScore ?? "—") + ' · Urgency ' +
          escapeHtml(product.urgencyScore ?? "—") + '</div></div>' +
          '<div><div class="metric-label">Decision</div><div class="metric-value"><span class="badge ' +
          escapeHtml(recommendation) + '">' + escapeHtml(recommendation) + '</span></div></div>' +
          '<div><div class="metric-label">Marketplace</div><div class="metric-value">' +
          escapeHtml(e ? labelMarketplace(e.marketplace) : "—") + '</div></div>' +
          '<div><div class="metric-label">Demand</div><div class="metric-value">' +
          escapeHtml(e ? score(e.demandScore) : "—") + '</div></div>' +
          '<div><div class="metric-label">Market ref.</div><div class="metric-value">' +
          escapeHtml(e ? money(e.marketReferencePricePaise) : "—") + '</div></div>' +
          '<div><div class="metric-label">Suggested</div><div class="metric-value">' +
          escapeHtml(e ? money(e.suggestedPricePaise) : "—") + '</div></div>' +
        '</div>' +
        '<details><summary>View economics, strategy, blockers & evidence</summary>' +
          '<div class="detail">' +
            '<div><h3>Pricing</h3>' +
              '<div class="meta">Strategy: ' + escapeHtml(strategy) + '</div>' +
              '<div class="meta">Supplier cost: ' + escapeHtml(e ? money(e.supplierCostPaise) : "—") + '</div>' +
              '<div class="meta">Floor: ' + escapeHtml(e ? money(e.suggestedFloorPricePaise) : "—") + '</div>' +
              '<div class="meta">Suggested: ' + escapeHtml(e ? money(e.suggestedPricePaise) : "—") + '</div>' +
              '<div class="meta">Ceiling: ' + escapeHtml(e ? money(e.suggestedCeilingPricePaise) : "—") + '</div>' +
              '<div class="meta">Gross profit/unit: ' + escapeHtml(e ? money(e.estimatedGrossProfitPaise) : "—") + '</div>' +
              '<div class="meta">Gross margin: ' + escapeHtml(e ? pct(e.estimatedGrossMarginBps) : "—") + '</div>' +
              '<div class="meta">Pricing confidence: ' + escapeHtml(e ? score(e.pricingConfidenceScore) : "—") + '/100</div>' +
              '<div class="meta">Net profit verified: ' + (e && e.netProfitVerified ? "YES" : "NO") + '</div>' +
            '</div>' +
            '<div><h3>Demand & risk</h3>' +
              '<div class="meta">Competition: ' + escapeHtml(e ? score(e.competitionScore) : "—") + '/100</div>' +
              '<div class="meta">Trend confidence: ' + escapeHtml(e ? score(e.trendConfidence) : "—") + '/100</div>' +
              '<div class="meta">Reactive / Predictive / Structural: ' +
              escapeHtml(e ? e.demandReactive + " / " + e.demandPredictive + " / " + e.demandStructural : "—") +
              '</div><div class="pillrow" style="margin-top:10px">' +
              (risks.length ? risks.map((r) => '<span class="pill">' + escapeHtml(r) + '</span>').join("") : '<span class="pill">No flagged physical risk</span>') +
              '</div><h3>Blockers</h3><div class="pillrow">' +
              (blockers.length ? blockers.map((b) => '<span class="pill">' + escapeHtml(b) + '</span>').join("") : '<span class="pill">None</span>') +
              '</div></div>' +
            '<div><h3>Evidence</h3>' +
              (sources.length ? sources.map((source) =>
                '<a class="source" target="_blank" rel="noreferrer" href="' +
                escapeHtml(source.url) + '">' + escapeHtml(source.kind) + ' · ' +
                escapeHtml(source.url) + '</a>'
              ).join("") : '<div class="meta">No deep-research sources stored yet.</div>') +
              '<h3>Research history</h3>' +
              '<div class="meta">Lifecycle: ' + escapeHtml(product.lifecycleState) + '</div>' +
              '<div class="meta">Last research: ' + escapeHtml(product.lastDeepResearchedAt ?? "—") + '</div>' +
              '<div class="meta">Product key: ' + escapeHtml(product.productKey) + '</div>' +
            '</div>' +
          '</div>' +
        '</details>' +
      '</article>';
    }

    function renderProducts() {
      const query = document.getElementById("search").value.trim().toLowerCase();
      const rec = document.getElementById("recommendation").value;
      const market = document.getElementById("marketplace").value;

      const products = snapshot.products.filter((product) => {
        const e = product.evaluation;
        const haystack = [
          product.title,
          product.category,
          product.intentId,
          product.productKey
        ].join(" ").toLowerCase();
        const matchesQuery = !query || haystack.includes(query);
        const recommendation = e ? e.recommendation : "UNEVALUATED";
        const matchesRec = !rec || recommendation === rec;
        const matchesMarket = !market || (e && e.marketplace === market);
        return matchesQuery && matchesRec && matchesMarket;
      });

      document.getElementById("products").innerHTML = products.length
        ? products.map(productHtml).join("")
        : '<div class="empty">No products match these filters.</div>';
      document.getElementById("footer").textContent =
        "Showing " + products.length + " of " + snapshot.products.length +
        " products · Snapshot " + snapshot.generatedAt;
    }

    async function load() {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("Dashboard data request failed.");
      snapshot = await response.json();
      renderStats();
      renderProducts();
    }

    for (const id of ["search", "recommendation", "marketplace"]) {
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
</html>`;

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
