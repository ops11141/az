import { chromium } from "playwright";
import fs from "node:fs/promises";

const target = process.env.TARGET_URL;
const searchValue = process.env.SEARCH_VALUE || "";
if (!target) throw new Error("TARGET_URL is required");

const u = new URL(target);
if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http/https URLs are allowed.");

const blocked = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|fc|fd|fe80)/i;
if (blocked.test(u.hostname) || u.hostname.endsWith(".local")) {
  throw new Error("Private/local targets are not allowed.");
}

const MAX_PAGES = 12;
const MAX_BODY = 3 * 1024 * 1024;
const MAX_CAPTURE = 700000;

const seen = new Set();
const pages = [];
const network = [];

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({
  viewport:{width:1440,height:1000},
  ignoreHTTPSErrors:false
});
const page = await context.newPage();

async function captureResponse(response) {
  const req = response.request();
  if (!["xhr","fetch","document"].includes(req.resourceType())) return;

  const headers = response.headers();
  const type = headers["content-type"] || "";
  const item = {
    url: response.url(),
    method: req.method(),
    status: response.status(),
    resourceType: req.resourceType(),
    contentType: type
  };

  // Keep request metadata useful for understanding public data endpoints,
  // but never collect cookies, authorization headers, or credentials.
  const postData = req.postData();
  if (postData && postData.length <= 5000 && /application\/x-www-form-urlencoded|application\/json|text\/plain/i.test(headers["content-type"] || "")) {
    item.requestBody = postData;
  }

  if (/json|text|html|xml|csv/i.test(type)) {
    try {
      const body = await response.body();
      if (body.length <= MAX_CAPTURE) item.body = body.toString("utf8");
    } catch {}
  }

  network.push(item);
}

page.on("response", response => {
  captureResponse(response).catch(() => {});
});

async function submitPublicSearch() {
  if (!searchValue) return;

  const formInfo = await page.evaluate((value) => {
    const form = document.querySelector("form");
    if (!form) return {attempted:false, reason:"No form found"};

    const field = form.querySelector('input[name="meter"], input[name="search"], input[type="search"], input[type="text"]');
    if (!field) return {attempted:false, reason:"No suitable public search field found"};

    const fields = {};
    for (const el of [...form.elements]) {
      if (!el.name || el.disabled) continue;
      if ((el.type || "").toLowerCase() === "submit") continue;
      if ((el.type || "").toLowerCase() === "checkbox" && !el.checked) continue;
      fields[el.name] = el.value || "";
    }
    fields[field.name] = value;

    return {
      attempted:true,
      method:(form.method || "get").toUpperCase(),
      action:form.action || location.href,
      field:field.name,
      fields
    };
  }, searchValue);

  if (!formInfo.attempted) return formInfo;

  const action = new URL(formInfo.action, target).href;
  let response;
  let body = "";

  try {
    if (formInfo.method === "POST") {
      response = await context.request.post(action, {
        form: formInfo.fields,
        timeout: 15000
      });
    } else {
      const q = new URL(action);
      for (const [key, value] of Object.entries(formInfo.fields)) {
        q.searchParams.set(key, value);
      }
      response = await context.request.get(q.href, {timeout:15000});
    }

    body = await response.text();
  } catch (error) {
    return {attempted:true, error:`Search request failed: ${error}`};
  }

  network.push({
    url:action,
    method:formInfo.method,
    status:response.status(),
    resourceType:"document",
    contentType:response.headers()["content-type"] || "",
    requestBody:formInfo.fields,
    body:body.length <= MAX_CAPTURE ? body : undefined
  });

  const resultPage = await context.newPage();
  try {
    await resultPage.setContent(body, {waitUntil:"domcontentloaded", timeout:10000});

    const data = await resultPage.evaluate(() => {
      const clean = s => (s || "").trim();
      const tables = [...document.querySelectorAll("table")].map((t,i)=>({
        index:i,
        rows:[...t.querySelectorAll("tr")].map(tr =>
          [...tr.querySelectorAll("th,td")].map(td => clean(td.innerText))
        )
      }));

      const fields = {};
      for (const row of document.querySelectorAll("table tr")) {
        const cells = [...row.querySelectorAll("th,td")].map(td => clean(td.innerText));
        if (cells.length >= 2 && cells[0]) fields[cells[0].replace(/:$/, "")] = cells.slice(1).join(" ").trim();
      }

      const links = [...document.querySelectorAll("a[href]")].map(a => ({
        text:clean(a.innerText),
        href:a.href
      }));

      const mapLink = links.find(x => /google\\.com\\/maps/i.test(x.href))?.href || "";
      const whatsappLink = links.find(x => /whatsapp:/i.test(x.href))?.href || "";
      const coordMatch = mapLink.match(/[?&]query=(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?)/i);

      return {
        title:document.title,
        htmlBytes:document.documentElement.outerHTML.length,
        tables,
        fields,
        links,
        mapLink,
        whatsappLink,
        latitude:coordMatch ? Number(coordMatch[1]) : null,
        longitude:coordMatch ? Number(coordMatch[2]) : null,
        text:(document.body?.innerText || "").slice(0,500000)
      };
    });

    pages.push({
      url:action,
      status:response.status(),
      searchValue,
      searchResult:true,
      resultUrl:action,
      ...data
    });
  } finally {
    await resultPage.close();
  }

  return {
    attempted:true,
    method:formInfo.method,
    action,
    status:response.status()
  };
}
async function inspect(url) {
  if (seen.has(url) || seen.size >= MAX_PAGES) return;
  seen.add(url);

  try {
    const response = await page.goto(url, {
      waitUntil:"domcontentloaded",
      timeout:30000
    });

    // Give normal XHR/fetch calls time to appear without waiting forever
    // for sites that keep connections open.
    await page.waitForTimeout(1800);

    const html = await page.content();
    if (html.length > MAX_BODY) throw new Error("page too large");

    const data = await page.evaluate(() => {
      const clean = s => (s || "").trim();

      const tables = [...document.querySelectorAll("table")].map((t,i)=>({
        index:i,
        rows:[...t.querySelectorAll("tr")].map(tr =>
          [...tr.querySelectorAll("th,td")].map(td => clean(td.innerText))
        )
      }));

      const forms = [...document.forms].map(f=>({
        method:(f.method || "get").toUpperCase(),
        action:f.action,
        enctype:f.enctype || "",
        fields:[...f.elements]
          .filter(e=>e.name)
          .map(e=>({
            name:e.name,
            type:e.type || "text",
            value:e.type === "password" ? "" : (e.value || ""),
            required:!!e.required
          }))
      }));

      const links = [...document.querySelectorAll("a[href]")].map(a=>a.href);
      const scripts = [...document.scripts].map(s=>s.src || "inline");

      const embeddedJson = [
        ...document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]')
      ].map((s,i)=>({index:i,text:s.textContent.trim()}));

      const endpointCandidates = [
        ...new Set([
          ...forms.map(f=>f.action),
          ...links.filter(u => /\.(json|xml|csv)(\?|$)|api|ajax|search|data/i.test(u)),
          ...scripts.filter(u => /api|ajax|search|data/i.test(u))
        ])
      ];

      return {
        title:document.title,
        forms,
        tables,
        links,
        scripts,
        embeddedJson,
        endpointCandidates
      };
    });

    pages.push({
      url,
      status:response?.status() || 0,
      htmlBytes:html.length,
      ...data
    });

    const base = new URL(url);

    for (const link of data.links) {
      try {
        const x = new URL(link);
        const sameOrigin = x.origin === base.origin;
        const pageLike =
          x.pathname.endsWith(".html") ||
          x.pathname.endsWith(".php") ||
          x.pathname === "/" ||
          !x.pathname.includes(".");

        if (sameOrigin && pageLike) await inspect(x.href);
      } catch {}

      if (seen.size >= MAX_PAGES) break;
    }
  } catch (error) {
    pages.push({url,error:String(error)});
  }
}

await inspect(target);
await submitPublicSearch();

// Let pending response-body reads finish.
await page.waitForTimeout(1200);
await browser.close();

const result = {
  target,
  generatedAt:new Date().toISOString(),
  limits:{maxPages:MAX_PAGES,maxBodyBytes:MAX_BODY,maxCapturedResponseBytes:MAX_CAPTURE},
  pages,
  network
};

await fs.mkdir("output",{recursive:true});
await fs.writeFile("output/extraction.json",JSON.stringify(result,null,2));

const searchResults = pages
  .filter(p => p.searchResult && p.fields)
  .map(p => ({
    searchValue: p.searchValue || "",
    resultUrl: p.resultUrl || p.url || "",
    minipillarNo: p.fields["Minipillar No."] || p.fields["Minipillar No"] || "",
    type: p.fields["Type"] || "",
    manufacture: p.fields["Manfacture"] || p.fields["Manufacture"] || "",
    location: p.fields["Location"] || "",
    latitude: p.latitude,
    longitude: p.longitude,
    mapLink: p.mapLink || "",
    whatsappLink: p.whatsappLink || ""
  }));

await fs.writeFile("output/search-results.json", JSON.stringify(searchResults, null, 2));

const resultHeaders = ["searchValue","resultUrl","minipillarNo","type","manufacture","location","latitude","longitude","mapLink","whatsappLink"];
await fs.writeFile(
  "output/search-results.csv",
  [resultHeaders, ...searchResults.map(r => resultHeaders.map(k => r[k]))]
    .map(r => r.map(v => '"' + csv(v) + '"').join(","))
    .join("\n")
);

const rows = [];
for (const p of pages) {
  for (const t of p.tables || []) {
    for (const r of t.rows || []) rows.push([p.url,t.index,...r]);
  }
}
const csv = v => String(v ?? "").replaceAll('"','""');
await fs.writeFile(
  "output/tables.csv",
  rows.map(r => r.map(v => '"' + csv(v) + '"').join(",")).join("\n")
);

const endpointRows = [];
for (const p of pages) {
  for (const e of p.endpointCandidates || []) endpointRows.push([p.url,e]);
}
await fs.writeFile(
  "output/endpoints.csv",
  [["page","endpoint"],...endpointRows]
    .map(r => r.map(v => '"' + csv(v) + '"').join(","))
    .join("\n")
);

const safe = s => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const report = `<!doctype html>
<meta charset="utf-8">
<title>Public Extraction Report</title>
<h1>Public extraction report</h1>
<p><b>Target:</b> ${safe(target)}</p>
<p><b>Pages:</b> ${pages.length} — <b>Network responses:</b> ${network.length}</p>
<h2>Detected endpoints</h2>
<pre>${safe(JSON.stringify(endpointRows,null,2))}</pre>
<h2>Pages</h2>
<pre>${safe(JSON.stringify(pages,null,2))}</pre>
<h2>Network</h2>
<pre>${safe(JSON.stringify(network,null,2))}</pre>`;
await fs.writeFile("output/report.html",report);

console.log(JSON.stringify({
  pages:pages.length,
  network:network.length,
  files:[
    "output/extraction.json",
    "output/tables.csv",
    "output/endpoints.csv",
    "output/report.html"
  ]
},null,2));
