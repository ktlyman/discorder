import {
  getDb, searchMessages, getContext, getThread, getReplies,
  getRecent, getStats, listChannels, listGuilds, getMessagesByUser,
} from '../storage/db.js';

/**
 * DiscordAgent — a RAG-like query interface for Discord data.
 *
 * Designed to be used by AI agents, tools, or scripts that need
 * contextual information from Discord without hitting the Discord API
 * directly. All queries run against the local SQLite database populated
 * by the listener and/or history importer.
 *
 * Works like querying a RAG database or Gemini with NotebookLM —
 * ask a natural language question and get relevant messages plus
 * surrounding context.
 *
 * Usage:
 *   const agent = new DiscordAgent();
 *   const results = agent.search('deployment pipeline broken');
 *   const answer  = agent.ask('What did the team decide about the API?');
 */
export class DiscordAgent {
  constructor(opts = {}) {
    this.db = getDb(opts.dbPath);
  }

  // ── Core search ─────────────────────────────────────────────

  /**
   * Full-text search across all stored messages.
   * Accepts natural language or keywords — FTS5 handles stemming.
   *
   * @param {string} query - search terms
   * @param {object} opts
   * @param {number} opts.limit - max results (default 25)
   * @param {string} opts.channel - filter to a specific channel name or ID
   * @param {string} opts.guild - filter to a specific guild name or ID
   * @param {string} opts.user - filter to a specific user ID
   * @param {string} opts.before - only messages before this ISO timestamp
   * @param {string} opts.after - only messages after this ISO timestamp
   * @returns {Array} matching messages with user/channel/guild metadata
   */
  search(query, opts = {}) {
    const channelId = opts.channel ? this._resolveChannel(opts.channel) : undefined;
    const guildId = opts.guild ? this._resolveGuild(opts.guild) : undefined;
    return searchMessages(this.db, query, {
      limit: opts.limit,
      channelId,
      guildId,
      userId: opts.user,
      before: opts.before,
      after: opts.after,
    });
  }

  // ── Context retrieval ───────────────────────────────────────

  /**
   * Get messages surrounding a specific message for conversational context.
   *
   * @param {string} channel - channel name or ID
   * @param {string} messageId - Discord message ID (snowflake)
   * @param {number} window - number of surrounding messages (default 10)
   */
  context(channel, messageId, window = 10) {
    const channelId = this._resolveChannel(channel);
    return getContext(this.db, channelId, messageId, window);
  }

  /**
   * Get all messages in a thread by thread channel ID.
   *
   * @param {string} threadId - the thread channel's ID
   */
  thread(threadId) {
    return getThread(this.db, threadId);
  }

  /**
   * Get all replies to a specific message (via reference_id).
   *
   * @param {string} messageId - the parent message's ID
   */
  replies(messageId) {
    return getReplies(this.db, messageId);
  }

  /**
   * Get the N most recent messages from a channel.
   *
   * @param {string} channel - channel name or ID
   * @param {number} limit - max results (default 50)
   */
  recent(channel, limit = 50) {
    const channelId = this._resolveChannel(channel);
    return getRecent(this.db, channelId, limit);
  }

  // ── User queries ────────────────────────────────────────────

  /**
   * Get messages posted by a specific user.
   *
   * @param {string} userQuery - user ID, display name, or username
   * @param {object} opts
   */
  userMessages(userQuery, opts = {}) {
    const userId = this._resolveUser(userQuery);
    const channelId = opts.channel ? this._resolveChannel(opts.channel) : undefined;
    const guildId = opts.guild ? this._resolveGuild(opts.guild) : undefined;
    return getMessagesByUser(this.db, userId, { channelId, guildId, limit: opts.limit });
  }

  // ── Metadata ────────────────────────────────────────────────

  /** Get summary stats (message count, channels, users, guilds, threads). */
  stats() {
    return getStats(this.db);
  }

  /** List all channels in the database. */
  channels(guild) {
    const guildId = guild ? this._resolveGuild(guild) : undefined;
    return listChannels(this.db, guildId);
  }

  /** List all guilds in the database. */
  guilds() {
    return listGuilds(this.db);
  }

  /** List all users in the database. */
  users() {
    return this.db.prepare(
      'SELECT id, username, display_name, is_bot FROM users ORDER BY username'
    ).all();
  }

  // ── Compound queries (agent-friendly) ───────────────────────

  /**
   * "Ask" the Discord corpus a question. Returns a structured response with
   * the most relevant messages, plus surrounding context for the top hits.
   * Designed to be consumed directly by an LLM agent — similar to querying
   * a RAG database or Gemini with NotebookLM.
   *
   * @param {string} question - natural language question
   * @param {object} opts
   * @param {number} opts.topK - number of top results (default 5)
   * @param {number} opts.contextWindow - surrounding messages per hit (default 6)
   * @returns {{ query: string, hits: Array, context: Object, stats: Object }}
   */
  ask(question, opts = {}) {
    const topK = opts.topK ?? 5;
    const contextWindow = opts.contextWindow ?? 6;

    const hits = this.search(question, { limit: topK, ...opts });
    const contextMap = {};

    for (const hit of hits) {
      // If it's a thread message, fetch the full thread
      if (hit.thread_id) {
        const key = `thread:${hit.thread_id}`;
        if (contextMap[key]) continue;
        contextMap[key] = {
          type: 'thread',
          channel: hit.channel_name,
          guild: hit.guild_name,
          messages: getThread(this.db, hit.thread_id),
        };
      } else {
        // Top-level message — fetch surrounding context
        const key = `context:${hit.channel_id}:${hit.id}`;
        if (contextMap[key]) continue;
        contextMap[key] = {
          type: 'context',
          channel: hit.channel_name,
          guild: hit.guild_name,
          messages: getContext(this.db, hit.channel_id, hit.id, contextWindow),
        };
      }
    }

    return {
      query: question,
      hits: hits.map(h => ({
        id: h.id,
        channel: h.channel_name,
        guild: h.guild_name,
        user: h.user_display_name || h.user_name,
        content: h.content,
        thread_id: h.thread_id,
        created_at: h.created_at,
      })),
      context: contextMap,
      stats: getStats(this.db),
    };
  }

  // ── Private helpers ─────────────────────────────────────────

  _resolveChannel(query) {
    if (!query) return undefined;
    const clean = query.replace(/^#/, '');
    // Try by ID first
    const byId = this.db.prepare('SELECT id FROM channels WHERE id = ?').get(clean);
    if (byId) return byId.id;
    // Then by name (case-insensitive)
    const byName = this.db.prepare('SELECT id FROM channels WHERE LOWER(name) = LOWER(?)').get(clean);
    return byName?.id ?? clean;
  }

  _resolveGuild(query) {
    if (!query) return undefined;
    const byId = this.db.prepare('SELECT id FROM guilds WHERE id = ?').get(query);
    if (byId) return byId.id;
    const byName = this.db.prepare('SELECT id FROM guilds WHERE LOWER(name) = LOWER(?)').get(query);
    return byName?.id ?? query;
  }

  _resolveUser(query) {
    if (!query) return undefined;
    const byId = this.db.prepare('SELECT id FROM users WHERE id = ?').get(query);
    if (byId) return byId.id;
    const byName = this.db.prepare(
      'SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(display_name) = LOWER(?)'
    ).get(query, query);
    return byName?.id ?? query;
  }
}
