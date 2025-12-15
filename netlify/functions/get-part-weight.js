// netlify/functions/get-part-weight.js

export async function handler(event) {
  try {
    const qs = event.queryStringParameters || {};
    const part = (qs.part || "").trim();
    const qty = parseInt(qs.qty || "1", 10);

    if (!part) return json(400, { error: "Missing ?part=..." });
    if (!Number.isFinite(qty) || qty <= 0) return json(400, { error: "Invalid ?qty= (must be >= 1)" });

    const apiKey = process.env.MOUSER_API_KEY;
    if (!apiKey) {
      return json(500, { error: "MOUSER_API_KEY not set in Netlify environment variables" });
    }

    // 1) Mouser Part Number Search (to identify part)
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

    const parts = apiData?.SearchResults?.Parts;
    const first = Array.isArray(parts) ? parts[0] : null;

    if (!first) {
      return json(200, {
        weight: null,
        unitWeightLbs: null,
        unitWeightG: null,
        qty,
        totalWeightLbs: null,
        totalWeightG: null,
        source: "Mouser (Not Found)",
        error: "Not found on Mouser",
      });
    }

    // Keep useful identifiers
    const manufacturer = first.Manufacturer || null;
    const manufacturerPartNumber = first.ManufacturerPartNumber || null;
    const mouserPartNumber = first.MouserPartNumber || null;
    const description = first.Description || null;

    // 2) Try to infer package from MPN / Mouser PN / description
    const packageCode = inferSmdPackage({
      part,
      manufacturerPartNumber,
      mouserPartNumber,
      description,
    });

    // 3) Package → typical unit weight (grams)
    const unitWeightG = packageCode ? typicalUnitWeightG(packageCode) : null;

    if (unitWeightG == null) {
      return json(200, {
        weight: null,
        unitWeightLbs: null,
        unitWeightG: null,
        qty,
        totalWeightLbs: null,
        totalWeightG: null,
        source: "Package Lookup (No Match)",
        description,
        manufacturer,
        manufacturerPartNumber,
        mouserPartNumber,
        productUrl: first.ProductDetailUrl || null,
        datasheetUrl: first.DataSheetUrl || null,
        detectedPackage: packageCode,
        error: "Could not infer package / no weight mapping",
      });
    }

    const unitWeightLbs = gToLbs(unitWeightG);
    const totalWeightG = unitWeightG * qty;
    const totalWeightLbs = gToLbs(totalWeightG);

    return json(200, {
      weight: totalWeightLbs,          // backward compatible (total lbs)
      unitWeightLbs,
      unitWeightG,
      qty,
      totalWeightLbs,
      totalWeightG,

      source: "Package Lookup",
      detectedPackage: packageCode,

      description,
      manufacturer,
      manufacturerPartNumber,
      mouserPartNumber,
      productUrl: first.ProductDetailUrl || null,
      datasheetUrl: first.DataSheetUrl || null,
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

function gToLbs(g) {
  return g / 453.59237;
}

/**
 * Detect common SMD size codes: 0402 0603 0805 1206 1210 1812 2010 2512 etc
 * Works great for resistors/caps/inductors where size is in part number.
 */
function inferSmdPackage({ part, manufacturerPartNumber, mouserPartNumber, description }) {
  const hay = [
    part,
    manufacturerPartNumber,
    mouserPartNumber,
    description,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  // Direct size codes in text
  const m = hay.match(/\b(01005|0201|0402|0603|0805|1008|1206|1210|1806|1812|2010|2512)\b/);
  if (m) return m[1];

  // Sometimes Mouser PN looks like "71-CRCW0805-1.0K-E3" (already handled)
  // Try to match "...0805..." even without word boundaries
  const m2 = hay.match(/(01005|0201|0402|0603|0805|1008|1206|1210|1806|1812|2010|2512)/);
  if (m2) return m2[1];

  return null;
}

/**
 * Typical single-component weights (GRAMS).
 * These are practical shipping weights (not perfect metrology).
 * You can tune these numbers over time using your actual shipments.
 */
function typicalUnitWeightG(packageCode) {
  const table = {
    // Tiny passives
    "01005": 0.0001,
    "0201": 0.0002,
    "0402": 0.0005,
    "0603": 0.0010,
    "0805": 0.0055,  // matches your screenshot example (5.500 mg)
    "1008": 0.0100,
    "1206": 0.0150,
    "1210": 0.0200,
    "1806": 0.0300,
    "1812": 0.0400,
    "2010": 0.0600,
    "2512": 0.0900,
  };

  return table[packageCode] ?? null;
}
