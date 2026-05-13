export default () => ({
  port: Number.parseInt(process.env.PORT || '3000', 10),
  soundcloud: {
    accessToken: process.env.SOUNDCLOUD_ACCESS_TOKEN || '',
    authEntrypoint: process.env.SOUNDCLOUD_AUTH_ENTRYPOINT || 'pkce_authorize',
    clientId: process.env.SOUNDCLOUD_CLIENT_ID || '',
    clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET || '',
    redirectUri: process.env.SOUNDCLOUD_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    oauthScope: process.env.SOUNDCLOUD_OAUTH_SCOPE || '',
  },
  database: {
    path: process.env.DATABASE_PATH || './data/soundcloud-desktop.sqlite',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  admin: {
    token: process.env.ADMIN_TOKEN || '',
  },
  lyrics: {
    qwenAsrUrl: process.env.QWEN_ASR_URL || process.env.VOSK_ASR_URL || '',
    qwenAsrKey: process.env.QWEN_ASR_KEY || process.env.VOSK_ASR_KEY || '',
  },
});
