export const handler = async (event) => {
  try {
    const shipment = JSON.parse(event.body || "{}");

    // For now we just log to Netlify logs.
    console.log("Shipment logged:", shipment);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error("log-shipment error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
