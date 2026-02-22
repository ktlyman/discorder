import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Create a discord.js Client configured for the resolved auth mode.
 *
 * The client is configured with all intents needed for message listening,
 * history import, and member/channel metadata collection.
 *
 * @param {{ mode: string, token: string }} auth
 *   — config object returned by resolveAuth()
 * @returns {Client}
 */
export function createClient(auth) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageTyping,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
    ],
  });

  // Attach auth info so downstream code knows the mode
  client._authMode = auth.mode;
  client._authToken = auth.token;

  return client;
}

/**
 * Log in to Discord and wait until the client is ready.
 *
 * @param {Client} client
 * @param {string} token
 * @returns {Promise<Client>}
 */
export async function loginClient(client, token) {
  return new Promise((resolve, reject) => {
    client.once('ready', () => resolve(client));
    client.once('error', reject);
    client.login(token);
  });
}
