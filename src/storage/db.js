import Database from 'better-sqlite3';
import path from 'node:path';

let _db = null;

/**
 * Open (or return the cached) SQLite database and ensure all tables exist.
 */
export function getDb(dbPath) {
  if (_db) return _db;

  const resolved = path.resolve(dbPath || process.env.DATABASE_PATH || './discord-agent.db');
  _db = new Database(resolved);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    -----------------------------------------------------------------
    -- Core tables
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS guilds (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      icon          TEXT DEFAULT '',
      owner_id      TEXT DEFAULT '',
      member_count  INTEGER DEFAULT 0,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id            TEXT PRIMARY KEY,
      guild_id      TEXT,
      name          TEXT,
      type          INTEGER DEFAULT 0,
      topic         TEXT DEFAULT '',
      parent_id     TEXT DEFAULT '',
      position      INTEGER DEFAULT 0,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT,
      display_name  TEXT DEFAULT '',
      discriminator TEXT DEFAULT '0',
      is_bot        INTEGER DEFAULT 0,
      avatar        TEXT DEFAULT '',
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS members (
      guild_id      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      nickname      TEXT DEFAULT '',
      roles         TEXT DEFAULT '[]',
      joined_at     TEXT,
      updated_at    TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      guild_id      TEXT,
      author_id     TEXT,
      content       TEXT,
      thread_id     TEXT,
      reference_id  TEXT,
      reply_count   INTEGER DEFAULT 0,
      reactions     TEXT,
      attachments   TEXT,
      embeds        TEXT,
      raw           TEXT,
      created_at    TEXT,
      edited_at     TEXT,
      imported_at   TEXT DEFAULT (datetime('now'))
    );

    -- Index for channel-based lookups
    CREATE INDEX IF NOT EXISTS idx_messages_channel
      ON messages(channel_id);

    -- Index for thread lookups
    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id) WHERE thread_id IS NOT NULL;

    -- Index for author lookups
    CREATE INDEX IF NOT EXISTS idx_messages_author
      ON messages(author_id);

    -- Index for chronological queries
    CREATE INDEX IF NOT EXISTS idx_messages_created
      ON messages(created_at);

    -- Index for guild-based lookups
    CREATE INDEX IF NOT EXISTS idx_messages_guild
      ON messages(guild_id);

    -----------------------------------------------------------------
    -- Full-text search virtual table (FTS5)
    -----------------------------------------------------------------
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_text,
      user_name,
      channel_name,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    -----------------------------------------------------------------
    -- Triggers to keep FTS in sync
    -----------------------------------------------------------------
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text, user_name, channel_name)
      VALUES (
        new.rowid,
        new.content,
        COALESCE((SELECT display_name FROM users WHERE id = new.author_id),
                 (SELECT username FROM users WHERE id = new.author_id), ''),
        COALESCE((SELECT name FROM channels WHERE id = new.channel_id), '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, user_name, channel_name)
      VALUES ('delete', old.rowid, old.content,
        COALESCE((SELECT display_name FROM users WHERE id = old.author_id),
                 (SELECT username FROM users WHERE id = old.author_id), ''),
        COALESCE((SELECT name FROM channels WHERE id = old.channel_id), '')
      );
    END;

    -----------------------------------------------------------------
    -- Import tracking
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS import_cursors (
      channel_id    TEXT PRIMARY KEY,
      oldest_id     TEXT,
      latest_id     TEXT,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -----------------------------------------------------------------
    -- Roles
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS roles (
      id            TEXT PRIMARY KEY,
      guild_id      TEXT NOT NULL,
      name          TEXT,
      color         INTEGER DEFAULT 0,
      position      INTEGER DEFAULT 0,
      permissions   TEXT DEFAULT '0',
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -----------------------------------------------------------------
    -- Pins
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS pins (
      message_id    TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      guild_id      TEXT,
      pinned_at     TEXT
    );

    -----------------------------------------------------------------
    -- Custom emoji
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS emoji (
      id            TEXT PRIMARY KEY,
      guild_id      TEXT NOT NULL,
      name          TEXT,
      animated      INTEGER DEFAULT 0,
      url           TEXT DEFAULT '',
      updated_at    TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ── Upsert helpers ──────────────────────────────────────────────

export function upsertGuild(db, guild) {
  db.prepare(`
    INSERT INTO guilds (id, name, icon, owner_id, member_count, updated_at)
    VALUES (@id, @name, @icon, @owner_id, @member_count, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      icon = excluded.icon,
      owner_id = excluded.owner_id,
      member_count = excluded.member_count,
      updated_at = datetime('now')
  `).run({
    id: guild.id,
    name: guild.name ?? '',
    icon: guild.icon ?? '',
    owner_id: guild.ownerId ?? guild.owner_id ?? '',
    member_count: guild.memberCount ?? guild.member_count ?? 0,
  });
}

export function upsertChannel(db, ch) {
  db.prepare(`
    INSERT INTO channels (id, guild_id, name, type, topic, parent_id, position, updated_at)
    VALUES (@id, @guild_id, @name, @type, @topic, @parent_id, @position, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      guild_id = excluded.guild_id,
      name = excluded.name,
      type = excluded.type,
      topic = excluded.topic,
      parent_id = excluded.parent_id,
      position = excluded.position,
      updated_at = datetime('now')
  `).run({
    id: ch.id,
    guild_id: ch.guildId ?? ch.guild_id ?? null,
    name: ch.name ?? '',
    type: ch.type ?? 0,
    topic: ch.topic ?? '',
    parent_id: ch.parentId ?? ch.parent_id ?? '',
    position: ch.position ?? ch.rawPosition ?? 0,
  });
}

export function upsertUser(db, user) {
  db.prepare(`
    INSERT INTO users (id, username, display_name, discriminator, is_bot, avatar, updated_at)
    VALUES (@id, @username, @display_name, @discriminator, @is_bot, @avatar, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      discriminator = excluded.discriminator,
      is_bot = excluded.is_bot,
      avatar = excluded.avatar,
      updated_at = datetime('now')
  `).run({
    id: user.id,
    username: user.username ?? user.name ?? '',
    display_name: user.displayName ?? user.display_name ?? user.globalName ?? '',
    discriminator: user.discriminator ?? '0',
    is_bot: user.bot ? 1 : (user.is_bot ? 1 : 0),
    avatar: user.avatar ?? '',
  });
}

export function upsertMember(db, guildId, member) {
  const user = member.user ?? member;
  db.prepare(`
    INSERT INTO members (guild_id, user_id, nickname, roles, joined_at, updated_at)
    VALUES (@guild_id, @user_id, @nickname, @roles, @joined_at, datetime('now'))
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      nickname = excluded.nickname,
      roles = excluded.roles,
      joined_at = excluded.joined_at,
      updated_at = datetime('now')
  `).run({
    guild_id: guildId,
    user_id: user.id ?? member.id,
    nickname: member.nickname ?? member.nick ?? '',
    roles: JSON.stringify(
      member.roles?.cache?.map(r => r.id) ?? member.roles ?? []
    ),
    joined_at: member.joinedAt?.toISOString?.() ?? member.joined_at ?? null,
  });
}

export function upsertMessage(db, msg, channelId, guildId) {
  db.prepare(`
    INSERT INTO messages (id, channel_id, guild_id, author_id, content, thread_id,
                          reference_id, reply_count, reactions, attachments, embeds,
                          raw, created_at, edited_at)
    VALUES (@id, @channel_id, @guild_id, @author_id, @content, @thread_id,
            @reference_id, @reply_count, @reactions, @attachments, @embeds,
            @raw, @created_at, @edited_at)
    ON CONFLICT(id) DO UPDATE SET
      content      = excluded.content,
      reply_count  = excluded.reply_count,
      reactions    = excluded.reactions,
      attachments  = excluded.attachments,
      embeds       = excluded.embeds,
      raw          = excluded.raw,
      edited_at    = excluded.edited_at
  `).run({
    id: msg.id,
    channel_id: channelId ?? msg.channelId ?? msg.channel_id,
    guild_id: guildId ?? msg.guildId ?? msg.guild_id ?? null,
    author_id: msg.author?.id ?? msg.author_id ?? null,
    content: msg.content ?? '',
    thread_id: msg.thread?.id ?? msg.thread_id ?? null,
    reference_id: msg.reference?.messageId ?? msg.reference_id ?? null,
    reply_count: msg.thread?.messageCount ?? msg.reply_count ?? 0,
    reactions: msg.reactions?.cache
      ? JSON.stringify(msg.reactions.cache.map(r => ({
          emoji: r.emoji.name,
          count: r.count,
        })))
      : (msg.reactions ?? null),
    attachments: msg.attachments?.map
      ? JSON.stringify(msg.attachments.map(a => ({
          id: a.id,
          name: a.name,
          url: a.url,
          size: a.size,
          contentType: a.contentType,
        })))
      : (msg.attachments ?? null),
    embeds: msg.embeds?.length
      ? JSON.stringify(msg.embeds.map(e => ({
          title: e.title,
          description: e.description,
          url: e.url,
        })))
      : (msg.embeds ?? null),
    raw: JSON.stringify(msg.toJSON?.() ?? msg),
    created_at: msg.createdAt?.toISOString?.() ?? msg.created_at ?? null,
    edited_at: msg.editedAt?.toISOString?.() ?? msg.edited_at ?? null,
  });
}

export function upsertRole(db, guildId, role) {
  db.prepare(`
    INSERT INTO roles (id, guild_id, name, color, position, permissions, updated_at)
    VALUES (@id, @guild_id, @name, @color, @position, @permissions, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      color = excluded.color,
      position = excluded.position,
      permissions = excluded.permissions,
      updated_at = datetime('now')
  `).run({
    id: role.id,
    guild_id: guildId,
    name: role.name ?? '',
    color: role.color ?? 0,
    position: role.position ?? role.rawPosition ?? 0,
    permissions: role.permissions?.bitfield?.toString?.() ?? role.permissions ?? '0',
  });
}

export function upsertPin(db, msg, channelId, guildId) {
  db.prepare(`
    INSERT INTO pins (message_id, channel_id, guild_id, pinned_at)
    VALUES (@message_id, @channel_id, @guild_id, @pinned_at)
    ON CONFLICT(message_id) DO UPDATE SET
      pinned_at = excluded.pinned_at
  `).run({
    message_id: msg.id,
    channel_id: channelId,
    guild_id: guildId ?? null,
    pinned_at: msg.pinnedAt?.toISOString?.() ?? msg.pinned_at ?? null,
  });
}

export function upsertEmoji(db, guildId, emoji) {
  db.prepare(`
    INSERT INTO emoji (id, guild_id, name, animated, url, updated_at)
    VALUES (@id, @guild_id, @name, @animated, @url, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      animated = excluded.animated,
      url = excluded.url,
      updated_at = datetime('now')
  `).run({
    id: emoji.id,
    guild_id: guildId,
    name: emoji.name ?? '',
    animated: emoji.animated ? 1 : 0,
    url: emoji.url ?? emoji.imageURL?.() ?? '',
  });
}

// ── Query helpers ───────────────────────────────────────────────

/**
 * Full-text search across all stored messages.
 * Returns messages with user and channel names attached.
 */
export function searchMessages(db, query, { limit = 25, channelId, guildId, userId, before, after } = {}) {
  // Sanitize the query for FTS5: strip special characters, wrap tokens in quotes,
  // use OR so natural language questions find relevant results
  const sanitized = query
    .replace(/[^a-zA-Z0-9\s]/g, ' ')  // remove FTS5 special chars
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t}"`)
    .join(' OR ');

  if (!sanitized) return [];

  let where = `messages_fts MATCH @query`;
  const params = { query: sanitized, limit };

  if (channelId) { where += ` AND m.channel_id = @channelId`; params.channelId = channelId; }
  if (guildId)   { where += ` AND m.guild_id = @guildId`;     params.guildId = guildId; }
  if (userId)    { where += ` AND m.author_id = @userId`;     params.userId = userId; }
  if (before)    { where += ` AND m.created_at < @before`;    params.before = before; }
  if (after)     { where += ` AND m.created_at > @after`;     params.after = after; }

  return db.prepare(`
    SELECT m.id, m.channel_id, m.guild_id, m.author_id, m.content, m.thread_id,
           m.reference_id, m.reply_count, m.reactions, m.created_at,
           u.display_name AS user_display_name,
           u.username     AS user_name,
           c.name         AS channel_name,
           g.name         AS guild_name,
           rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    LEFT JOIN users u    ON u.id = m.author_id
    LEFT JOIN channels c ON c.id = m.channel_id
    LEFT JOIN guilds g   ON g.id = m.guild_id
    WHERE ${where}
    ORDER BY rank
    LIMIT @limit
  `).all(params);
}

/**
 * Get messages surrounding a specific message for context.
 */
export function getContext(db, channelId, messageId, windowSize = 10) {
  const half = Math.floor(windowSize / 2);

  // Get the target message's created_at for ordering
  const target = db.prepare(
    'SELECT created_at FROM messages WHERE id = @messageId'
  ).get({ messageId });

  if (!target) return [];

  return db.prepare(`
    SELECT m.id, m.author_id, m.content, m.thread_id, m.created_at,
           u.display_name AS user_display_name,
           u.username AS user_name,
           c.name AS channel_name
    FROM messages m
    LEFT JOIN users u    ON u.id = m.author_id
    LEFT JOIN channels c ON c.id = m.channel_id
    WHERE m.channel_id = @channelId
      AND m.created_at BETWEEN
        (SELECT created_at FROM messages WHERE channel_id = @channelId AND created_at <= @targetTs ORDER BY created_at DESC LIMIT 1 OFFSET @half)
        AND
        (SELECT created_at FROM messages WHERE channel_id = @channelId AND created_at >= @targetTs ORDER BY created_at ASC  LIMIT 1 OFFSET @half)
    ORDER BY m.created_at ASC
  `).all({ channelId, targetTs: target.created_at, half });
}

/**
 * Retrieve all messages in a thread by its thread (channel) ID.
 */
export function getThread(db, threadId) {
  return db.prepare(`
    SELECT m.id, m.author_id, m.content, m.thread_id, m.created_at,
           u.display_name AS user_display_name,
           u.username AS user_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.author_id
    WHERE m.channel_id = @threadId OR m.thread_id = @threadId
    ORDER BY m.created_at ASC
  `).all({ threadId });
}

/**
 * Get messages that are replies to a specific message (via reference_id).
 */
export function getReplies(db, messageId) {
  return db.prepare(`
    SELECT m.id, m.author_id, m.content, m.reference_id, m.created_at,
           u.display_name AS user_display_name,
           u.username AS user_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.author_id
    WHERE m.reference_id = @messageId
    ORDER BY m.created_at ASC
  `).all({ messageId });
}

/**
 * Get recent messages from a channel.
 */
export function getRecent(db, channelId, limit = 50) {
  return db.prepare(`
    SELECT m.id, m.author_id, m.content, m.thread_id, m.reply_count,
           m.created_at,
           u.display_name AS user_display_name,
           u.username AS user_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.author_id
    WHERE m.channel_id = @channelId
    ORDER BY m.created_at DESC
    LIMIT @limit
  `).all({ channelId, limit });
}

/**
 * Get summary stats for the database.
 */
export function getStats(db) {
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const channels = db.prepare('SELECT COUNT(*) as count FROM channels').get().count;
  const users    = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const guilds   = db.prepare('SELECT COUNT(*) as count FROM guilds').get().count;
  const threads  = db.prepare('SELECT COUNT(DISTINCT thread_id) as count FROM messages WHERE thread_id IS NOT NULL').get().count;
  return { messages, channels, users, guilds, threads };
}

/**
 * List all stored channels, optionally filtered by guild.
 */
export function listChannels(db, guildId) {
  if (guildId) {
    return db.prepare(
      'SELECT id, guild_id, name, type, topic, parent_id FROM channels WHERE guild_id = @guildId ORDER BY position'
    ).all({ guildId });
  }
  return db.prepare(
    'SELECT id, guild_id, name, type, topic, parent_id FROM channels ORDER BY guild_id, position'
  ).all();
}

/**
 * List all stored guilds.
 */
export function listGuilds(db) {
  return db.prepare('SELECT id, name, icon, member_count FROM guilds ORDER BY name').all();
}

/**
 * Get messages by a specific user, optionally filtered to a channel.
 */
export function getMessagesByUser(db, userId, { channelId, guildId, limit = 50 } = {}) {
  let sql = `
    SELECT m.id, m.channel_id, m.guild_id, m.content, m.thread_id, m.created_at,
           c.name AS channel_name,
           g.name AS guild_name,
           u.display_name AS user_display_name
    FROM messages m
    LEFT JOIN channels c ON c.id = m.channel_id
    LEFT JOIN guilds g   ON g.id = m.guild_id
    LEFT JOIN users u    ON u.id = m.author_id
    WHERE m.author_id = @userId
  `;
  const params = { userId, limit };
  if (channelId) { sql += ` AND m.channel_id = @channelId`; params.channelId = channelId; }
  if (guildId)   { sql += ` AND m.guild_id = @guildId`;     params.guildId = guildId; }
  sql += ` ORDER BY m.created_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params);
}

// ── Import cursor helpers ───────────────────────────────────────

/**
 * Get the import cursor for a channel (latest message ID imported).
 */
export function getImportCursor(db, channelId) {
  return db.prepare(
    'SELECT latest_id FROM import_cursors WHERE channel_id = ?'
  ).get(channelId)?.latest_id ?? null;
}

/**
 * Update the import cursor after importing messages.
 */
export function setImportCursor(db, channelId, latestId) {
  db.prepare(`
    INSERT INTO import_cursors (channel_id, latest_id, updated_at)
    VALUES (@channel_id, @latest_id, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      latest_id = excluded.latest_id,
      updated_at = datetime('now')
  `).run({ channel_id: channelId, latest_id: latestId });
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
