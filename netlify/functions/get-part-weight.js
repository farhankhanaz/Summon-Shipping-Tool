export const handler = async (event) => {
  try {
    const { partNumber } = JSON.parse(event.body || "{}");

    // 1) Internal DB (you can expand this later)
    const internalDB = {
      "LM7805": { weight: 0.002, source: "Internal DB", description: "Voltage Regulator" },
      "ATMEGA328P": { weight: 0.003, source: "Internal DB", description: "Microcontroller" }
    };

    if (internalDB[partNumber]) {
      return {
        statusCode: 200,
        body: JSON.stringify(internalDB[partNumber]),
      };
    }

    // 2) Mouser API (real when API key is added to Netlify)
    const mouserKey = process.env.MOUSER_API_KEY;

    if (mouserKey) {
      const resp = await fetch("https://api.mouser.com/api/v1/search/partnumber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: mouserKey,
          SearchByPartRequest: { partNumber }
        })
      });

      const data = await resp.json();
      const part = data?.SearchResults?.Parts?.[0];

      if (part?.UnitWeightKg) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            weight: part.UnitWeightKg * 2.20462,
            source: "Mouser API",
            description: part.Description || "Mouser Part"
          })
        };
      }
    }

    // 3) DigiKey API will be added later

    // 4) AI / fallback estimate
    return {
      statusCode: 200,
      body: JSON.stringify({
        weight: 0.01,
        source: "AI Estimate",
        description: "Fallback estimated weight",
      }),
    };
  } catch (err) {
    console.error("get-part-weight error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
