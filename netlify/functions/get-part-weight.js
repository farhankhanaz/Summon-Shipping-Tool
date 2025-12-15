// netlify/functions/get-part-weight.js

export async function handler(event) {
  try {
    const part = (event.queryStringParameters?.part || "").trim();
    if (!part) return json(400, { error: "Missing ?part=..." });

    const apiKey = process.env.MOUSER_API_KEY;
    if (!apiKey) return json(500, { error: "MOUSER_API_KEY not set in Netlify environment variables" });

    // 1) Mouser API search (part number endpoint)
    const apiUrl = `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(apiKey)}`;

    const apiResp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        SearchByPartRequest: {
          mouserPartNumber: part,
          partSearchOptions: "string",
        },
      }),
    });

    const apiData = await apiResp.json().catch(() => ({}));
    if (!apiResp.ok) {
      return json(apiResp.status, { error: "Mouser API request failed", details: apiData });
    }

    // Mouser response can vary; these cover common shapes
    const products =
      apiData?.SearchResults?.Parts ||
      apiData?.SearchResults?.Parts?.Parts ||
      apiData?.SearchResults?.Parts?.Part ||
      [];

    const first = Array.isArray(products) ? products[0] : null;

    if (!first) {
      return json(200, {
        weight: null,
        source: "Mouser API",
        description: null,
        manufacturer: null,
        manufacturerPartNumber: part,
        mouserPartNumber: null,
        productUrl: null,
        datasheetUrl: null,
        rawWeight: null,
        scrapedFromHtml: null,
        parsedFrom: null,
        error: "Not found on Mouser",
      });
    }

    const productUrl = first.ProductDetailUrl || null;

    // 2) Try to read weight from API fields / attributes
    const rawWeightFromApi =
      first.Weight ||
      first.UnitWeight ||
      first?.ProductAttributes?.find?.((a) => /unit\s*weight|weight/i.test(a?.AttributeName || ""))?.AttributeValue ||
      null;

    let rawWeight = rawWeightFromApi;
    let scrapedFromHtml = null;

    // 3) If API did not provide weight, scrape HTML (Mouser-first still)
    if (!rawWeight && productUrl) {
      const htmlResult = await scrapeUnitWeightFromMouserPage(productUrl);
      if (htmlResult?.rawWeight) {
        rawWeight = htmlResult.rawWeight;
        scrapedFromHtml = htmlResult.rawWeight;
      }
    }

    // 4) Parse weight into lbs
    const { weightLbs, parsedFrom } = parseWeightToLbs(rawWeight);

    return json(200, {
      weight: weightLbs, // lbs
      source: weightLbs ? (rawWeightFromApi ? "Mouser API" : "Mouser HTML") : "Mouser (No Weight)",
      description: first.Description || null,
      manufacturer: first.Manufacturer || null,
      manufacturerPartNumber: first.ManufacturerPartNumber || part,
      mouserPartNumber: first.MouserPartNumber || null,
      productUrl,
      datasheetUrl: first.DataSheetUrl || null,
      rawWeight: rawWeight || null,
      scrapedFromHtml: scrapedFromHtml || null,
      parsedFrom: parsedFrom || null,
      error: weightLbs
        ? null
        : productUrl
          ? "Weight not found (API + HTML scrape)"
          : "Weight not found (API only)",
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

/**
 * Mouser pages often render specs in HTML tables, but sometimes they’re in
 * embedded JSON/script tags. We try multiple patterns.
 */
async function scrapeUnitWeightFromMouserPage(url) {
  try {
    // Ensure we fetch the same host Mouser redirects you to (www2 is common)
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        // Some sites return different HTML without a UA
        "User-Agent": "Mozilla/5.0 (compatible; NetlifyFunction/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    const html = await resp.text().catch(() => "");
    if (!html) return { rawWeight: null };

    // Normalize whitespace to make regex easier
    const compact = html.replace(/\s+/g, " ");

    // ✅ Pattern A: Table row like:
    // <td>Unit Weight:</td><td>5.500 mg</td>
    let m =
      compact.match(/Unit\s*Weight\s*:?<\/[^>]*>\s*<\/td>\s*<td[^>]*>\s*([0-9.,]+\s*(?:mg|g|kg|oz|lb|lbs))/i) ||
      compact.match(/Unit\s*Weight\s*:?<\/td>\s*<td[^>]*>\s*([0-9.,]+\s*(?:mg|g|kg|oz|lb|lbs))/i);

    if (m?.[1]) return { rawWeight: cleanWeight(m[1]) };

    // ✅ Pattern B: Plain text somewhere:
    // Unit Weight: 5.500 mg
    m = compact.match(/Unit\s*Weight\s*:\s*([0-9.,]+\s*(?:mg|g|kg|oz|lb|lbs))/i);
    if (m?.[1]) return { rawWeight: cleanWeight(m[1]) };

    // ✅ Pattern C: Sometimes appears in JSON blobs / script text:
    // "Unit Weight":"5.500 mg" or "unitWeight":"5.500 mg"
    m =
      compact.match(/"Unit\s*Weight"\s*:\s*"([^"]+?)"/i) ||
      compact.match(/"unitWeight"\s*:\s*"([^"]+?)"/i) ||
      compact.match(/unitWeight\\?":\\?"([^\\"]+?)\\?"/i);

    if (m?.[1] && /(?:mg|g|kg|oz|lb|lbs)/i.test(m[1])) return { rawWeight: cleanWeight(m[1]) };

    return { rawWeight: null };
  } catch {
    return { rawWeight: null };
  }
}

function cleanWeight(s) {
  // remove commas and trim
  return String(s).replace(/,/g, "").trim();
}

// Accepts things like "0.009 g", "9 mg", "2 kg", "0.51 lb"
function parseWeightToLbs(raw) {
  if (!raw || typeof raw !== "string") return { weightLbs: null, parsedFrom: null };

  const s = raw.trim();
  const m = s.match(/([\d.]+)\s*(mg|g|kg|lb|lbs|oz)\b/i);
  if (!m) return { weightLbs: null, parsedFrom: s };

  const value = parseFloat(m[1]);
  if (!isFinite(value)) return { weightLbs: null, parsedFrom: s };

  const unit = (m[2] || "").toLowerCase();

  let lbs = null;
  if (unit === "mg") lbs = (value / 1000) / 453.59237; // mg → g → lb
  else if (unit === "g") lbs = value / 453.59237;
  else if (unit === "kg") lbs = (value * 1000) / 453.59237;
  else if (unit === "oz") lbs = value / 16;
  else if (unit === "lb" || unit === "lbs") lbs = value;

  // round a bit for readability (keep good precision)
  if (lbs !== null) lbs = Number(lbs.toFixed(10));

  return { weightLbs: lbs, parsedFrom: s };
}
