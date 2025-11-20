export const handler = async (event) => {
  try {
    const { weight, originZip, destZip, residential } = JSON.parse(event.body || "{}");

    // Temporary formula (safe + predictable)
    // We will replace this with real UPS + FedEx next.
    const residentialFee = residential ? 4 : 0;

    const upsRate = 15 + weight * 1.8 + residentialFee;
    const fedexRate = 16 + weight * 1.6 + residentialFee;

    return {
      statusCode: 200,
      body: JSON.stringify({
        ups: { ground: upsRate.toFixed(2), service: "UPS Ground (simulated)" },
        fedex: { ground: fedexRate.toFixed(2), service: "FedEx Ground (simulated)" },
      }),
    };
  } catch (err) {
    console.error("get-shipping-rates error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
