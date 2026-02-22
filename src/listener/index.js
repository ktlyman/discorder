import { Events, ChannelType } from 'discord.js';
import { getDb, upsertMessage, upsertChannel, upsertUser, upsertMember, upsertGuild } from '../storage/db.js';
import { createClient, loginClient } from '../auth/client.js';

/**
 * Start the real-time Discord message listener using the Gateway (WebSocket).
 *
 * Listens for:
 *  - messageCreate (new messages in guilds and DMs)
 *  - messageUpdate (edits)
 *  - messageReactionAdd / messageReactionRemove
 *  - channelCreate / channelUpdate
 *  - guildMemberAdd (triggers user sync)
 *  - threadCreate (auto-joins and tracks new threads)
 *
 * Every captured event is persisted to the local SQLite database so the
 * agent query layer always has fresh data.
 *
 * @param {object} opts
 * @param {string} [opts.dbPath] — path to SQLite database
 * @param {string} opts.token — Discord bot token
 * @param {Function} [opts.onMessage] — callback for each new/edited message
 * @returns {Promise<import('discord.js').Client>}
 */
export async function startListener(opts = {}) {
  const db = getDb(opts.dbPath);
  const client = opts.client ?? createClient({ mode: 'bot', token: opts.token });

  // ── Guild ready — sync metadata ──────────────────────────────
  client.on(Events.ClientReady, () => {
    console.log(`Discord listener ready as ${client.user.tag}`);
    console.log(`Watching ${client.guilds.cache.size} guild(s)`);

    // Sync all guilds and their channels
    for (const guild of client.guilds.cache.values()) {
      upsertGuild(db, guild);
      for (const channel of guild.channels.cache.values()) {
        upsertChannel(db, channel);
      }
    }
  });

  // ── Messages ────────────────────────────────────────────────
  client.on(Events.MessageCreate, (message) => {
    if (message.partial) return;

    // Store the author
    if (message.author) {
      upsertUser(db, message.author);
    }

    // Store member info if in a guild
    if (message.member) {
      upsertMember(db, message.guildId, message.member);
    }

    upsertMessage(db, message, message.channelId, message.guildId);

    if (opts.onMessage) {
      opts.onMessage({
        type: 'new',
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        author: message.author?.username,
        content: message.content,
      });
    }
  });

  // ── Message edits ──────────────────────────────────────────
  client.on(Events.MessageUpdate, async (_old, newMsg) => {
    try {
      if (newMsg.partial) newMsg = await newMsg.fetch();
      upsertMessage(db, newMsg, newMsg.channelId, newMsg.guildId);

      if (opts.onMessage) {
        opts.onMessage({
          type: 'edited',
          guildId: newMsg.guildId,
          channelId: newMsg.channelId,
          messageId: newMsg.id,
          author: newMsg.author?.username,
          content: newMsg.content,
        });
      }
    } catch { /* partial fetch failed — non-critical */ }
  });

  // ── Reactions ──────────────────────────────────────────────
  client.on(Events.MessageReactionAdd, async (reaction) => {
    try {
      if (reaction.partial) reaction = await reaction.fetch();
      const msg = reaction.message.partial
        ? await reaction.message.fetch()
        : reaction.message;
      upsertMessage(db, msg, msg.channelId, msg.guildId);
    } catch { /* non-critical */ }
  });

  client.on(Events.MessageReactionRemove, async (reaction) => {
    try {
      if (reaction.partial) reaction = await reaction.fetch();
      const msg = reaction.message.partial
        ? await reaction.message.fetch()
        : reaction.message;
      upsertMessage(db, msg, msg.channelId, msg.guildId);
    } catch { /* non-critical */ }
  });

  // ── Channel events ────────────────────────────────────────
  client.on(Events.ChannelCreate, (channel) => {
    upsertChannel(db, channel);
  });

  client.on(Events.ChannelUpdate, (_old, channel) => {
    upsertChannel(db, channel);
  });

  // ── Thread events — auto-join new threads ──────────────────
  client.on(Events.ThreadCreate, async (thread) => {
    upsertChannel(db, thread);
    // Auto-join the thread so we receive messages
    if (thread.joinable && !thread.joined) {
      try {
        await thread.join();
      } catch { /* non-critical */ }
    }
  });

  // ── Guild events ──────────────────────────────────────────
  client.on(Events.GuildCreate, (guild) => {
    upsertGuild(db, guild);
    for (const channel of guild.channels.cache.values()) {
      upsertChannel(db, channel);
    }
  });

  // ── Member events ─────────────────────────────────────────
  client.on(Events.GuildMemberAdd, (member) => {
    upsertUser(db, member.user);
    upsertMember(db, member.guild.id, member);
  });

  // ── Start ─────────────────────────────────────────────────
  await loginClient(client, opts.token ?? client._authToken);
  return client;
}
