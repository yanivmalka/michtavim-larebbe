// Allows the Android app (Capacitor serves it from https://localhost) to call the API.
const DEFAULT_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

export function cors(extra = process.env.CORS_ORIGINS) {
  const allowed = new Set([...DEFAULT_ORIGINS, ...(extra ? extra.split(',').map((s) => s.trim()) : [])]);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}
