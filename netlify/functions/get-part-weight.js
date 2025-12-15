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

    // Mouser Part Number Search endpoint
    const url = `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(apiKey)}`;

    const body = {
      SearchByPartRequest: {
        mouserPartNumber: part,
        partSearchOptions: "string", // Mouser expects a string here; this is the common safe value
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await resp.json().catch(() => ({}));

    // If Mouser returns an error message, forward it
    if (!resp.ok) {
      return json(resp.status, {
        error: "Mouser API request failed",
        details: data,
      });
    }

    const products =
      data?.SearchResults?.Parts || data?.SearchResults?.Parts?.Parts || data?.SearchResults?.Parts || [];

    const first = Array.isArray(products) ? products[0] : null;
    if (!first) {
      return json(200, {
        weight: null,
        source: "Mouser API",
        description: null,
        productUrl: null,
        datasheetUrl: null,
        error: "Not found on Mouser",
      });
    }

    // Mouser fields vary by category; try common keys
    const rawWeight =
      first.Weight ||
      first?.ProductAttributes?.find?.((a) => /weight/i.test(a?.AttributeName || ""))?.AttributeValue ||
      null;

    const { weightLbs, parsedFrom } = parseWeightToLbs(rawWeight);

    return json(200, {
      weight: weightLbs,                // lbs
      source: "Mouser API",
      description: first.Description || first.ManufacturerPartNumber || null,
      productUrl: first.ProductDetailUrl || first?.ProductDetailUrl || null,
      datasheetUrl: first.DataSheetUrl || first?.DataSheetUrl || null,
      rawWeight: rawWeight || null,     // keep for debugging
      parsedFrom,
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

// Accepts things like "0.009 g", "9 mg", "2 kg", "0.51 lb"
function parseWeightToLbs(raw) {
  if (!raw || typeof raw !== "string") return { weightLbs: null, parsedFrom: null };

  const s = raw.trim();
  const m = s.match(/([\d.]+)\s*(mg|g|kg|lb|lbs|oz)?/i);
  if (!m) return { weightLbs: null, parsedFrom: s };

  const value = parseFloat(m[1]);
  if (!isFinite(value)) return { weightLbs: null, parsedFrom: s };

  const unit = (m[2] || "").toLowerCase();

  let lbs = null;
  if (unit === "mg") lbs = value / 1000 / 453.59237;
  else if (unit === "g") lbs = value / 453.59237;
  else if (unit === "kg") lbs = value * 1000 / 453.59237;
  else if (unit === "oz") lbs = value / 16;
  else if (unit === "lb" || unit === "lbs") lbs = value;
  else {
    // If unit missing, don’t guess
    lbs = null;
  }

  return { weightLbs: lbs, parsedFrom: s };
}
