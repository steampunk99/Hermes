module.exports = {
  // Scriptnetworks provider config (kept as-is)
  scriptNetworks: {
    baseUrl: 'https://scriptnetworks.net/api',
    secretKey: process.env.SCRIPT_NETWORKS_SECRET_KEY,
    password: process.env.SCRIPT_NETWORKS_PASSWORD,
    authToken: process.env.SCRIPT_NETWORKS_AUTH_TOKEN,
    webhookUrl: `${process.env.API_URL}/webhook/mm`
  },

  // --- Mobile Money Fee Helpers (read-only; do not apply in execution yet) ---
  fees: (() => {
    try {
      // Load local tiered fees config (mmfees.json)
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const raw = require('./mmfees.json');
      return raw;
    } catch (e) {
      return { operators: {}, phonePrefixes: {}, currency: 'UGX' };
    }
  })(),

  // Determine operator from phone using configured prefixes. Returns 'MTN' | 'AIRTEL' | null
  getOperator(phone) {
    try {
      const cleaned = String(phone).replace(/\D/g, '');
      const { phonePrefixes = {} } = this.fees;
      for (const [op, prefixes] of Object.entries(phonePrefixes)) {
        for (const p of prefixes) {
          if (cleaned.startsWith(String(p).replace(/\D/g, ''))) return op.toUpperCase();
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  },

  // Compute provider fee for an operator/table/amount using a single regex to parse range keys like "500-2500"
  // Returns { fee, charge, tax, currency, tier }
  calcProviderFee({ operator, table, amount }) {
    const op = operator && operator.toUpperCase();
    const amt = Number(amount);
    const currency = (this.fees && this.fees.currency) || 'UGX';
    if (!op || !Number.isFinite(amt) || !this.fees.operators) {
      return { fee: 0, charge: 0, tax: 0, currency, tier: null };
    }
    const opCfg = this.fees.operators[op];
    if (!opCfg || !opCfg[table]) {
      return { fee: 0, charge: 0, tax: 0, currency, tier: null };
    }

    let matched = null; // { min, max, val }
    const rangeRe = /^(\d+)-(\d+)$/; // captures min and max as numbers
    for (const [rangeKey, val] of Object.entries(opCfg[table])) {
      const m = String(rangeKey).match(rangeRe);
      if (!m) continue;
      const min = parseInt(m[1], 10);
      const max = parseInt(m[2], 10);
      if (Number.isNaN(min) || Number.isNaN(max)) continue;
      if (amt >= min && amt <= max) {
        matched = { min, max, val };
        break;
      }
    }

    if (!matched) return { fee: 0, charge: 0, tax: 0, currency, tier: null };

    let fee = 0;
    let charge = 0;
    let tax = 0;
    if (typeof matched.val === 'number') {
      fee = matched.val;
      charge = matched.val;
      tax = 0;
    } else if (matched.val && typeof matched.val === 'object') {
      charge = Number(matched.val.charge || 0);
      tax = Number(matched.val.tax || 0);
      fee = charge + tax;
    }

    return { fee, charge, tax, currency, tier: { min: matched.min, max: matched.max } };
  }
};