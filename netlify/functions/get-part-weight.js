// netlify/functions/get-part-weight.js

export async function handler(event) {
  try {
    const part = (event.queryStringParameters?.part || "").trim();
    if (!part) return json(400, { error: "Missing ?part=..." });

    const apiKey = process.env.MOUSER_API_KEY;
    if (!apiKey) return json(500, { error: "MOUSER_API_KEY not set" });

    // 1) Mouser API search
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
    const partInfo = apiData?.SearchResults?.Parts?.[0];

    if (!partInfo) {
      return json(200, { error: "Not found on Mouser", details: apiData });
    }

    // Prefer Mouser ProductDetailUrl, but normalize to www2 (often the actual canonical host)
    let productUrl = partInfo.ProductDetailUrl || null;
    if (productUrl) {
      productUrl = productUrl.replace("https://www.mouser.com/", "https://www2.mouser.com/");
    }

    let rawWeight = null;
    let scrapedFromHtml = null;
    let htmlStatus = null;
    let htmlFinalUrl = null;

    // 2) HTML scrape
    if (productUrl) {
      const htmlResp = await fetch(productUrl, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
      });

      htmlStatus = htmlResp.status;
      htmlFinalUrl = htmlResp.url;

      const html = await htmlResp.text();

      // If Mouser blocks (403/503), you'll usually see "Access Denied" in HTML
      if (htmlResp.ok) {
        rawWeight = extractUnitWeight(html);
        if (rawWeight) scrapedFromHtml = htmlFinalUrl || productUrl;
      }
    }

    const { weightLbs, parsedFrom } = parseWeightToLbs(rawWeight);

    return json(200, {
      weight: weightLbs, // lbs
      source: rawWeight ? "Mouser HTML" : "Mouser (No Weight)",
      description: partInfo.Description || null,
      manufacturer: partInfo.Manufacturer || null,
      manufacturerPartNumber: partInfo.ManufacturerPartNumber || null,
      mouserPartNumber: partInfo.MouserPartNumber || null,
      productUrl,
      datasheetUrl: partInfo.DataSheetUrl || null,

      rawWeight: rawWeight || null,
      scrapedFromHtml: scrapedFromHtml || null,
      parsedFrom: parsedFrom || null,

      // Debug (helps us confirm scrape isn't blocked)
      htmlStatus,
      htmlFinalUrl,

      error: rawWeight ? null : "Weight not found (API + HTML scrape)",
    });
  } catch (err) {
    return json(500, { error: err?.message || "Server error" });
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Mouser HTML varies. This searches for a table row containing "Unit Weight"
 * and grabs the next cell's text value.
 */
function extractUnitWeight(html) {
  if (!html || typeof html !== "string") return null;

  // Pattern A: <td>Unit Weight:</td> <td>5.500 mg</td>
  let m = html.match(
    /<td[^>]*>\s*Unit\s*Weight\s*:?\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/i
  );
  if (m?.[1]) return cleanup(m[1]);

  // Pattern B: Sometimes "Unit Weight" is wrapped inside spans, strong, etc.
  m = html.match(
    /Unit\s*Weight\s*:?(?:\s*<\/[^>]+>)*\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/i
  );
  if (m?.[1]) return cleanup(m[1]);

  // Pattern C: Fallback: find "Unit Weight" then look ahead for something like "5.500 mg"
  m = html.match(/Unit\s*Weight[\s\S]{0,300}?([\d.]+\s*(mg|g|kg|oz|lb|lbs))/i);
  if (m?.[1]) return cleanup(m[1]);

  return null;

  function cleanup(s) {
    return String(s).replace(/&nbsp;/g, " ").trim();
  }
}

function parseWeightToLbs(raw) {
  if (!raw) return { weightLbs: null, parsedFrom: null };

  const m = String(raw).match(/([\d.]+)\s*(mg|g|kg|oz|lb|lbs)/i);
  if (!m) return { weightLbs: null, parsedFrom: raw };

  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();

  let lbs = null;
  if (unit === "mg") lbs = value / 1000 / 453.59237;
  else if (unit === "g") lbs = value / 453.59237;
  else if (unit === "kg") lbs = (value * 1000) / 453.59237;
  else if (unit === "oz") lbs = value / 16;
  else if (unit === "lb" || unit === "lbs") lbs = value;

  return { weightLbs: lbs, parsedFrom: raw };
}
