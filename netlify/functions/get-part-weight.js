// netlify/functions/get-part-weight.js

export async function handler(event) {
  try {
    const part = (event.queryStringParameters?.part || "").trim();
    if (!part) return json(400, { error: "Missing ?part=..." });

    const apiKey = process.env.MOUSER_API_KEY;
    if (!apiKey) return json(500, { error: "MOUSER_API_KEY not set" });

    // --- Step 1: Mouser API search ---
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

    const apiData = await apiResp.json();
    const partInfo = apiData?.SearchResults?.Parts?.[0];

    if (!partInfo) {
      return json(200, { error: "Not found on Mouser" });
    }

    const productUrl = partInfo.ProductDetailUrl;
    let rawWeight = null;
    let scrapedFromHtml = null;

    // --- Step 2: HTML scrape for Unit Weight ---
    if (productUrl) {
      const htmlResp = await fetch(productUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const html = await htmlResp.text();

      const match = html.match(
        /Unit Weight:\s*<\/td>\s*<td[^>]*>\s*([\d.]+\s*(mg|g|kg|oz|lb|lbs))/i
      );

      if (match) {
        rawWeight = match[1];
        scrapedFromHtml = productUrl;
      }
    }

    const { weightLbs, parsedFrom } = parseWeightToLbs(rawWeight);

    return json(200, {
      weight: weightLbs,
      source: rawWeight ? "Mouser HTML" : "Mouser (No Weight)",
      description: partInfo.Description || null,
      manufacturer: partInfo.Manufacturer || null,
      manufacturerPartNumber: partInfo.ManufacturerPartNumber || null,
      mouserPartNumber: partInfo.MouserPartNumber || null,
      productUrl,
      datasheetUrl: partInfo.DataSheetUrl || null,
      rawWeight,
      scrapedFromHtml,
      parsedFrom,
      error: rawWeight ? null : "Weight not found (API + HTML scrape)",
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
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

// --- Weight parsing ---
function parseWeightToLbs(raw) {
  if (!raw) return { weightLbs: null, parsedFrom: null };

  const m = raw.match(/([\d.]+)\s*(mg|g|kg|oz|lb|lbs)/i);
  if (!m) return { weightLbs: null, parsedFrom: raw };

  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();

  let lbs = null;
  if (unit === "mg") lbs = value / 1000 / 453.59237;
  if (unit === "g") lbs = value / 453.59237;
  if (unit === "kg") lbs = value * 1000 / 453.59237;
  if (unit === "oz") lbs = value / 16;
  if (unit === "lb" || unit === "lbs") lbs = value;

  return { weightLbs: lbs, parsedFrom: raw };
}
