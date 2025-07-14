module.exports = {
  scriptNetworks: {
    baseUrl: 'https://scriptnetworks.net/api',
    secretKey: process.env.SCRIPT_NETWORKS_SECRET_KEY,
    password:process.env.SCRIPT_NETWORKS_PASSWORD,
    authToken: process.env.SCRIPT_NETWORKS_AUTH_TOKEN,

    webhookUrl: `${process.env.API_URL}/api/v1/payments/status/callback`
  }
};