// netlify/functions/get-part-weight.js

exports.handler = async (event) => {
  try {
    const partRaw = (event.queryStringParameters?.part || "").trim();
    if (!partRaw) {
      return json(400, { error: "Missing ?part=" });
    }

    const part = partRaw.toUpperCase();
    const apiKey = process.env.MOUSER_API_KEY;

    if (!apiKey) {
      return json(500, { error: "MOUSER_API_KEY is not set in Netlify env vars" });
    }

    // 1) Try Mouser Search API (V2) via keyword search using the MPN as the keyword
    // Docs show: POST /api/v2/search/keywordandmanufacturer?apiKey=...
    const url = `https://api.mouser.com/api/v2/search/keywordandmanufacturer?apiKey=${encodeURIComponent(
      apiKey
    )}`;

    const body = {
      SearchByKeywordMfrNameRequest: {
        keyword: partRaw,      // keep original formatting for best match
        records: 25,
        pageNumber: 1,
        searchOptions: "None",
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

    // Mouser returns: { SearchResults: { Parts: [...] }, Errors: [...] }
    const errors = data?.Errors || [];
    if (!resp.ok || errors.length) {
      return json(200, {
        weight: null,
        source: "Mouser API",
        description: null,
        productUrl: null,
        datasheetUrl: null,
        error: errors[0]?.Message || `Mouser API error (HTTP ${resp.status})`,
      });
    }

    const parts = data?.SearchResults?.Parts || [];
    if (!parts.length) {
      return json(200, {
        weight: null,
        source: "Mouser API",
        description: null,
        productUrl: null,
        datasheetUrl: null,
        notFound: true,
      });
    }

    // Prefer exact MPN match if available
    const exact =
      parts.find(
        (p) => (p?.ManufacturerPartNumber || "").toUpperCase() === part
      ) || parts[0];

    const unitWeightKg = exact?.UnitWeightKg?.UnitWeight;

    // Convert kg → lbs
    const lbs =
      typeof unitWeightKg === "number" && isFinite(unitWeightKg)
        ? unitWeightKg * 2.2046226218
        : null;

    return json(200, {
      weight: lbs, // lbs per unit
      source: "Mouser API",
      description: exact?.Description || null,
      manufacturer: exact?.Manufacturer || null,
      manufacturerPartNumber: exact?.ManufacturerPartNumber || null,
      mouserPartNumber: exact?.MouserPartNumber || null,
      unitWeightKg: typeof unitWeightKg === "number" ? unitWeightKg : null,
      productUrl: exact?.ProductDetailUrl || null,
      datasheetUrl: exact?.DataSheetUrl || null,
    });
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      // allow browser calls from your site
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}
