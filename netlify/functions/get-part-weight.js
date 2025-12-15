// netlify/functions/get-part-weight.js

export async function handler(event) {
  try {
    const part = (event.queryStringParameters?.part || "").trim();
    if (!part) {
      return json(400, { error: "Missing ?part=..." });
    }

    const apiKey = process.env.MOUSER_API_KEY;
    if (!apiKey) {
      return json(500, { error: "MOUSER_API_KEY not set in Netlify environment variables" });
    }

    // 1) Mouser Part Number Search endpoint
    const url = `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(apiKey)}`;

    const body = {
      SearchByPartRequest: {
        mouserPartNumber: part,
        partSearchOptions: "string",
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return json(resp.status, {
        error: "Mouser API request failed",
        details: data,
      });
    }

    const parts = normalizeParts(data);

    const first = Array.isArray(parts) ? parts[0] : null;
    if (!first) {
      return json(200, {
        weight: null,
        source: "Mouser API",
        description: null,
        productUrl: null,
        datasheetUrl: null,
        rawWeight: null,
        scrapedFromHtml: null,
        parsedFrom: null,
        error: "Not found on Mouser",
      });
    }

    const productUrl = first?.ProductDetailUrl || null;
    const datasheetUrl = first?.DataSheetUrl || null;

    // 2) Try weight from Mouser API fields / attributes (rare)
    let rawWeight = extractWeightFromApi(first);

    // 3) If not in API, scrape Mouser product page HTML for "Unit Weight"
    let scrapedFromHtml = null;
    if (!rawWeight && productUrl) {
      scrapedFromHtml = await scrapeMouserUnitWeight(productUrl);
      rawWeight = scrapedFromHtml || null;
    }

    const { weightLbs } = parseWeightToLbs(rawWeight);

    return json(200, {
      weight: weightLbs, // lbs (number) or null
      source: rawWeight ? (scrapedFromHtml ? "Mouser (HTML Unit Weight)" : "Mouser API") : "Mouser (No Weight)",
      description: first.Description || first.ManufacturerPartNumber || null,
      manufacturer: first.Manufacturer || null,
      manufacturerPartNumber: first.ManufacturerPartNumber || null,
      mouserPartNumber: first.MouserPartNumber || null,
      productUrl,
      datasheetUrl,
      rawWeight: rawWeight || null,
      scrapedFromHtml: scrapedFromHtml || null, // TEMP DEBUG (we remove later)
      parsedFrom: rawWeight ? (scrapedFromHtml ? "HTML:Unit Weight" : "API") : null,
      error: weightLbs == null ? "Weight not found (API + HTML scrape)" : null,
    });
  } catch (e) {
    return json(500, { error: e?.message || "Server error" });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

// --- Normalize Mouser parts list ---
function normalizeParts(data) {
  const a = data?.SearchResults?.Parts;
  if (Array.isArray(a)) return a;

  const b = data?.SearchResults?.Parts?.Parts;
  if (Array.isArray(b)) return b;

  return [];
}

// --- Extract weight from API response fields (rare) ---
function extractWeightFromApi(first) {
  // direct fields (rare)
  const direct =
    (typeof first?.Weight === "string" && first.Weight.trim()) ? first.Weight.trim() : null;

  if (direct) return direct;

  // ProductAttributes (common place for specs, but often weight is missing)
  const attrs = normalizeAttributes(first?.ProductAttributes);

  const priority = [
    /unit\s*weight/i,
    /net\s*weight/i,
    /package\s*weight/i,
    /\bweight\b/i,
    /\bmass\b/i,
  ];

  for (const rx of priority) {
    const hit = attrs.find((a) => rx.test(a?.AttributeName || "") && (a?.AttributeValue || "").trim());
    if (hit) return String(hit.AttributeValue).trim();
  }

  return null;
}

function normalizeAttributes(productAttributes) {
  if (Array.isArray(productAttributes)) return productAttributes;

  const maybe = productAttributes?.ProductAttribute;
  if (Array.isArray(maybe)) return maybe;

  return [];
}

// --- Scrape Mouser product HTML for Unit Weight ---
async function scrapeMouserUnitWeight(productUrl) {
  try {
    const resp = await fetch(productUrl, {
      headers: {
        // Helps reduce bot-blocking
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!resp.ok) return null;

    const html = await resp.text();

    // Try several patterns (Mouser HTML changes often)
    const patterns = [
      // Pattern A: capture number+unit near "Unit Weight"
      /Unit\s*Weight[^A-Za-z0-9]{0,50}([\d.,]+\s*(mg|g|kg|lb|lbs|oz))/i,

      // Pattern B: sometimes "Unit Weight" appears in table-like HTML
      /Unit\s*Weight<\/[^>]*>\s*<[^>]*>\s*([^<]{1,40})</i,

      // Pattern C: Net Weight
      /Net\s*Weight[^A-Za-z0-9]{0,50}([\d.,]+\s*(mg|g|kg|lb|lbs|oz))/i,
    ];

    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        return m[1].replace(/,/g, "").trim(); // remove commas in numbers
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

// --- Convert text like "603.808 mg" / "0.009 g" / "0.06 oz" -> lbs ---
function parseWeightToLbs(raw) {
  if (!raw || typeof raw !== "string") return { weightLbs: null };

  const s = raw.replace(/,/g, "").trim();

  // Require a unit so we don't guess wrong
  const m = s.match(/([\d.]+)\s*(mg|g|kg|lb|lbs|oz)\b/i);
  if (!m) return { weightLbs: null };

  const value = parseFloat(m[1]);
  if (!isFinite(value)) return { weightLbs: null };

  const unit = m[2].toLowerCase();

  let lbs = null;
  if (unit === "mg") lbs = value / 1000 / 453.59237;
  else if (unit === "g") lbs = value / 453.59237;
  else if (unit === "kg") lbs = (value * 1000) / 453.59237;
  else if (unit === "oz") lbs = value / 16;
  else if (unit === "lb" || unit === "lbs") lbs = value;

  return { weightLbs: lbs };
}
