import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  claude: {
    model: env.CLAUDE_MODEL || 'claude-opus-5-5',
    effort: env.CLAUDE_EFFORT || 'medium',
  },
  whatsapp: {
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  },
};
