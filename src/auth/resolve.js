/**
 * Detect which authentication mode to use based on available environment
 * variables.
 *
 * Modes checked in priority order:
 *   1. bot — DISCORD_BOT_TOKEN (standard bot account)
 *   2. user — DISCORD_USER_TOKEN (self-bot / user account token)
 *
 * Bot mode is the recommended approach. User tokens are against Discord TOS
 * for automation but can be useful for one-time historical data export from
 * servers where you don't have bot-install permissions.
 *
 * @returns {{ mode: 'bot'|'user', token: string }}
 * @throws {Error} if no valid credentials are found
 */
export function resolveAuth() {
  if (process.env.DISCORD_BOT_TOKEN) {
    return {
      mode: 'bot',
      token: process.env.DISCORD_BOT_TOKEN,
    };
  }

  if (process.env.DISCORD_USER_TOKEN) {
    return {
      mode: 'user',
      token: process.env.DISCORD_USER_TOKEN,
    };
  }

  throw new Error(
    'No Discord credentials found. Configure one of the following:\n\n' +
    '  Bot mode (recommended — requires a Discord application):\n' +
    '    DISCORD_BOT_TOKEN    your bot token from the Discord Developer Portal\n\n' +
    '  User token mode (one-time export only — against Discord TOS for automation):\n' +
    '    DISCORD_USER_TOKEN   your user account token\n\n' +
    '  Required Discord bot permissions (Privileged Gateway Intents):\n' +
    '    - Message Content Intent\n' +
    '    - Server Members Intent\n' +
    '    - Presence Intent (optional)\n'
  );
}
