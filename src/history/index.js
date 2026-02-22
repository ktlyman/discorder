import { ChannelType, Collection } from 'discord.js';
import {
  getDb, upsertGuild, upsertChannel, upsertUser, upsertMember,
  upsertMessage, upsertRole, upsertPin, upsertEmoji,
  getImportCursor, setImportCursor,
} from '../storage/db.js';
import { createClient, loginClient } from '../auth/client.js';

const PAGE_SIZE = 100;  // Discord max is 100 messages per fetch
const RATE_LIMIT_PAUSE_MS = 1000;
const DEFAULT_CONCURRENCY = 2;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Simple rate limiter to stay under Discord's rate limits.
 */
function createRateLimiter(intervalMs) {
  let next = Date.now();
  return async function acquire() {
    const now = Date.now();
    if (now < next) {
      await sleep(next - now);
    }
    next = Math.max(Date.now(), next) + intervalMs;
  };
}

/**
 * Run an array of async tasks with bounded concurrency.
 */
async function parallelMap(items, concurrency, fn) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Import historical data from Discord into the local SQLite database.
 *
 * Steps:
 *  1. Sync all guilds
 *  2. Sync users/members from each guild
 *  3. Sync channels, roles, and emoji
 *  4. For each text channel, page through message history
 *  5. Import thread messages
 *  6. Import pinned messages
 *
 * Supports incremental imports via cursor tracking.
 *
 * @param {object} opts
 * @param {import('discord.js').Client} [opts.client] — pre-logged-in Client
 * @param {string} [opts.token] — Discord bot token (used if no client provided)
 * @param {string} [opts.dbPath]
 * @param {string[]} [opts.guilds] — specific guild IDs to import
 * @param {string[]} [opts.channels] — specific channel names or IDs to import
 * @param {boolean} [opts.includeThreads] — also import thread history (default true)
 * @param {number} [opts.concurrency] — parallel channel imports (default 2)
 * @param {Function} [opts.log]
 */
export async function importHistory(opts = {}) {
  const db = getDb(opts.dbPath);
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const includeThreads = opts.includeThreads ?? true;
  const log = opts.log ?? console.log;
  const throttle = createRateLimiter(RATE_LIMIT_PAUSE_MS);

  // Create and log in a client if not provided
  let client = opts.client;
  let shouldDestroy = false;
  if (!client) {
    const token = opts.token ?? process.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error('No Discord token provided');
    client = createClient({ mode: 'bot', token });
    await loginClient(client, token);
    shouldDestroy = true;
  }

  try {
    log(`Logged in as ${client.user.tag}`);

    // ── 1. Sync guilds ──────────────────────────────────────
    log('Syncing guilds...');
    let guilds = [...client.guilds.cache.values()];

    if (opts.guilds?.length) {
      const set = new Set(opts.guilds.map(g => g.toLowerCase()));
      guilds = guilds.filter(
        g => set.has(g.id) || set.has(g.name?.toLowerCase())
      );
    }

    for (const guild of guilds) {
      upsertGuild(db, guild);
    }
    log(`  ${guilds.length} guild(s) synced`);

    // Process each guild
    for (const guild of guilds) {
      log(`\nProcessing guild: ${guild.name} (${guild.id})`);

      // ── 2. Sync members ────────────────────────────────────
      log('  Syncing members...');
      let memberCount = 0;
      try {
        const members = await guild.members.fetch();
        for (const member of members.values()) {
          upsertUser(db, member.user);
          upsertMember(db, guild.id, member);
          memberCount++;
        }
      } catch (err) {
        log(`  Warning: member sync failed: ${err.message}`);
        // Fall back to what's in cache
        for (const member of guild.members.cache.values()) {
          upsertUser(db, member.user);
          upsertMember(db, guild.id, member);
          memberCount++;
        }
      }
      log(`  ${memberCount} members synced`);

      // ── 3. Sync channels ──────────────────────────────────
      log('  Syncing channels...');
      let allChannels;
      try {
        allChannels = await guild.channels.fetch();
      } catch {
        allChannels = guild.channels.cache;
      }

      for (const ch of allChannels.values()) {
        if (ch) upsertChannel(db, ch);
      }
      log(`  ${allChannels.size} channels synced`);

      // ── 4. Sync roles ─────────────────────────────────────
      log('  Syncing roles...');
      for (const role of guild.roles.cache.values()) {
        upsertRole(db, guild.id, role);
      }
      log(`  ${guild.roles.cache.size} roles synced`);

      // ── 5. Sync emoji ─────────────────────────────────────
      log('  Syncing emoji...');
      for (const emoji of guild.emojis.cache.values()) {
        upsertEmoji(db, guild.id, emoji);
      }
      log(`  ${guild.emojis.cache.size} emoji synced`);

      // ── 6. Import messages per channel ─────────────────────
      // Filter to text-based channels that we can read
      const textChannels = [...allChannels.values()].filter(ch => {
        if (!ch) return false;
        const textTypes = [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
        ];
        return textTypes.includes(ch.type);
      });

      // Apply channel filter if specified
      let targetChannels = textChannels;
      if (opts.channels?.length) {
        const set = new Set(opts.channels.map(c => c.toLowerCase()));
        targetChannels = textChannels.filter(
          ch => set.has(ch.id) || set.has(ch.name?.toLowerCase())
        );
        log(`  Filtering to ${targetChannels.length} requested channels`);
      }

      log(`  Importing ${targetChannels.length} text channels (concurrency: ${concurrency})...`);

      await parallelMap(targetChannels, concurrency, async (ch) => {
        await importChannel(client, db, ch, guild.id, { log, throttle });
      });

      // ── 7. Import threads ──────────────────────────────────
      if (includeThreads) {
        log('  Importing threads...');
        await importThreads(client, db, guild, targetChannels, { log, throttle, concurrency });
      }

      // ── 8. Import pins ─────────────────────────────────────
      log('  Importing pins...');
      await parallelMap(targetChannels, concurrency, async (ch) => {
        await importPins(client, db, ch, guild.id, { log, throttle });
      });
    }

    log('\nImport complete.');
  } finally {
    if (shouldDestroy) {
      client.destroy();
    }
  }
}

/**
 * Import a single channel's message history.
 */
async function importChannel(client, db, channel, guildId, opts) {
  const { log, throttle } = opts;
  const label = `#${channel.name}`;

  // Check cursor for incremental import
  const afterId = getImportCursor(db, channel.id);
  let msgCount = 0;
  let latestId = afterId;
  let lastId = undefined;

  log(`    Importing ${label} (${channel.id})...`);

  try {
    // Page through history (oldest-first by using 'after')
    // Discord fetches newest-first by default, so we use 'before' to paginate
    // and 'after' for incremental imports
    let hasMore = true;

    while (hasMore) {
      await throttle();

      const fetchOpts = { limit: PAGE_SIZE };
      if (afterId && !lastId) {
        // Incremental: start after the last imported message
        fetchOpts.after = afterId;
      } else if (lastId) {
        // Pagination: get messages before the oldest we've seen this run
        fetchOpts.before = lastId;
      }

      let messages;
      try {
        messages = await channel.messages.fetch(fetchOpts);
      } catch (err) {
        if (err.code === 50001 || err.code === 50013) {
          log(`    Skipping ${label}: missing access`);
          return;
        }
        throw err;
      }

      if (messages.size === 0) break;

      // Store messages in a transaction
      const msgArray = [...messages.values()];
      db.transaction(() => {
        for (const msg of msgArray) {
          upsertMessage(db, msg, channel.id, guildId);
          if (msg.author) upsertUser(db, msg.author);
        }
      })();

      msgCount += messages.size;

      // Track the latest (newest) message ID for cursor
      const newest = msgArray[0]; // Discord returns newest first
      if (!latestId || newest.id > (latestId ?? '0')) {
        latestId = newest.id;
      }

      // Get the oldest message ID for pagination
      const oldest = msgArray[msgArray.length - 1];
      lastId = oldest.id;

      hasMore = messages.size === PAGE_SIZE;
    }

    // Update import cursor
    if (latestId) {
      setImportCursor(db, channel.id, latestId);
    }

    if (msgCount > 0) {
      log(`    ${msgCount} messages imported from ${label}`);
    }
  } catch (err) {
    if (err.code === 50001 || err.code === 50013) {
      log(`    Skipping ${label}: missing access`);
      return;
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
      log(`    Timeout on ${label} — skipping`);
      return;
    }
    log(`    Error on ${label}: ${err.message} — skipping`);
  }
}

/**
 * Import active and archived threads from a guild's text channels.
 */
async function importThreads(client, db, guild, parentChannels, opts) {
  const { log, throttle, concurrency } = opts;
  const threads = [];

  // Fetch active threads
  try {
    await throttle();
    const active = await guild.channels.fetchActiveThreads();
    for (const thread of active.threads.values()) {
      threads.push(thread);
      upsertChannel(db, thread);
    }
  } catch (err) {
    log(`    Active threads fetch failed: ${err.message}`);
  }

  // Fetch archived threads per parent channel
  for (const parentCh of parentChannels) {
    try {
      await throttle();
      // Public archived threads
      let hasMore = true;
      let before;
      while (hasMore) {
        const archived = await parentCh.threads.fetchArchived({ limit: 100, before });
        for (const thread of archived.threads.values()) {
          threads.push(thread);
          upsertChannel(db, thread);
        }
        hasMore = archived.hasMore;
        if (archived.threads.size > 0) {
          before = archived.threads.last().id;
        } else {
          hasMore = false;
        }
        if (hasMore) await throttle();
      }
    } catch {
      // Not all channels support archived threads — skip silently
    }
  }

  log(`    Found ${threads.length} threads`);

  // Import messages from each thread
  await parallelMap(threads, concurrency, async (thread) => {
    try {
      await importChannel(client, db, thread, guild.id, opts);
    } catch {
      // Thread import failure is non-critical
    }
  });
}

/**
 * Import pinned messages for a channel.
 */
async function importPins(client, db, channel, guildId, opts) {
  const { throttle } = opts;
  try {
    await throttle();
    const pinned = await channel.messages.fetchPinned();
    if (pinned.size === 0) return;

    db.transaction(() => {
      for (const msg of pinned.values()) {
        upsertMessage(db, msg, channel.id, guildId);
        upsertPin(db, msg, channel.id, guildId);
        if (msg.author) upsertUser(db, msg.author);
      }
    })();
  } catch {
    // Pins fetch failure is non-critical (some channels don't support it)
  }
}
