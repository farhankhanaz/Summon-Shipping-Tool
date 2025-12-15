// netlify/functions/get-part-weight.js
export async function handler(event) {
  try {
    const part = (event.queryStringParameters?.part || "").trim();
    if (!part) return json(400, { error: "Missing ?part=..." });

    const apiKey = process.env.MOUSER_API_KEY;
    if (!apiKey) {
      return json(500, { error: "MOUSER_API_KEY not set in Netlify environment variables" });
    }

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

    // Mouser typically returns: data.SearchResults.Parts (array)
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
        parsedFrom: null,
        error: "Not found on Mouser",
      });
    }

    const productUrl = first.ProductDetailUrl || first?.ProductDetailUrl || null;
    const datasheetUrl = first.DataSheetUrl || first?.DataSheetUrl || null;

    // Try all likely places where weight might appear
    const { rawWeight, parsedFrom } = extractRawWeight(first);
    const { weightLbs } = parseWeightToLbs(rawWeight);

    return json(200, {
      weight: weightLbs, // lbs (number) or null
      source: "Mouser API",
      description: first.Description || first.ManufacturerPartNumber || null,
      productUrl,
      datasheetUrl,
      rawWeight: rawWeight ?? null,
      parsedFrom: parsedFrom ?? null,
      error: weightLbs == null ? "Weight not provided by Mouser for this listing" : null,
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

// --- Helpers ---

function normalizeParts(data) {
  // Most common:
  // data.SearchResults.Parts => array
  const partsA = data?.SearchResults?.Parts;
  if (Array.isArray(partsA)) return partsA;

  // Sometimes APIs wrap in another object:
  // data.SearchResults?.Parts?.Parts => array
  const partsB = data?.SearchResults?.Parts?.Parts;
  if (Array.isArray(partsB)) return partsB;

  // Fallback
  return [];
}

function extractRawWeight(product) {
  // 1) direct fields that sometimes exist
  const directCandidates = [
    ["UnitWeight", product?.UnitWeight],
    ["Weight", product?.Weight],
    ["NetWeight", product?.NetWeight],
    ["PackageWeight", product?.PackageWeight],
  ];

  for (const [from, val] of directCandidates) {
    if (typeof val === "string" && val.trim()) return { rawWeight: val.trim(), parsedFrom: from };
  }

  // 2) ProductAttributes (shape can vary)
  const attrs = normalizeAttributes(product?.ProductAttributes);

  // Priority order: names that usually mean physical weight
  const priority = [
    /unit\s*weight/i,
    /net\s*weight/i,
    /package\s*weight/i,
    /\bweight\b/i,
    /\bmass\b/i,
  ];

  for (const rx of priority) {
    const hit = attrs.find((a) => rx.test(a?.AttributeName || "") && (a?.AttributeValue || "").trim());
    if (hit) {
      return {
        rawWeight: (hit.AttributeValue || "").trim(),
        parsedFrom: `ProductAttributes:${hit.AttributeName}`,
      };
    }
  }

  return { rawWeight: null, parsedFrom: null };
}

function normalizeAttributes(productAttributes) {
  // Mouser sometimes returns:
  // ProductAttributes: [ {AttributeName, AttributeValue}, ... ]
  if (Array.isArray(productAttributes)) return productAttributes;

  // Or:
  // ProductAttributes: { ProductAttribute: [ ... ] }
  const maybe = productAttributes?.ProductAttribute;
  if (Array.isArray(maybe)) return maybe;

  return [];
}

// Accepts: "0.009 g", "9 mg", "2 kg", "0.51 lb", "603.808 mg", etc.
function parseWeightToLbs(raw) {
  if (!raw || typeof raw !== "string") return { weightLbs: null };

  // remove commas and extra text like "approx." if present
  const s = raw.replace(/,/g, "").trim();

  // capture first number + unit
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
