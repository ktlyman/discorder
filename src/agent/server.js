import express from 'express';
import { DiscordAgent } from './query.js';

/**
 * Start an HTTP server that exposes the DiscordAgent query interface as a
 * REST API. This lets any agent, script, or tool query Discord data over
 * HTTP — similar to querying a RAG database or Gemini with NotebookLM.
 *
 * Endpoints:
 *   POST /ask              — natural language query (compound search + context)
 *   POST /search           — full-text search
 *   GET  /guilds           — list guilds
 *   GET  /channels         — list channels (optional ?guild= filter)
 *   GET  /users            — list users
 *   GET  /recent/:ch       — recent messages in a channel
 *   GET  /thread/:threadId — messages in a thread
 *   GET  /replies/:msgId   — replies to a message
 *   GET  /context/:ch/:id  — messages surrounding a message
 *   GET  /user/:id         — messages by user
 *   GET  /stats            — database stats
 *   GET  /health           — health check
 */
export function startServer(opts = {}) {
  const port = opts.port ?? process.env.AGENT_API_PORT ?? 3141;
  const agent = new DiscordAgent(opts);
  const app = express();

  app.use(express.json());

  // ── Health ──────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ ok: true, ...agent.stats() });
  });

  // ── Ask (compound query — best for agents) ─────────────────
  app.post('/ask', (req, res) => {
    const { question, topK, contextWindow, channel, guild, user } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    try {
      const result = agent.ask(question, { topK, contextWindow, channel, guild, user });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Search ────────────────────────────────────────────────
  app.post('/search', (req, res) => {
    const { query, limit, channel, guild, user, before, after } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    try {
      const results = agent.search(query, { limit, channel, guild, user, before, after });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Guilds ────────────────────────────────────────────────
  app.get('/guilds', (_req, res) => {
    res.json({ guilds: agent.guilds() });
  });

  // ── Channels ──────────────────────────────────────────────
  app.get('/channels', (req, res) => {
    const guild = req.query.guild;
    res.json({ channels: agent.channels(guild) });
  });

  // ── Users ─────────────────────────────────────────────────
  app.get('/users', (_req, res) => {
    res.json({ users: agent.users() });
  });

  // ── Recent messages in a channel ──────────────────────────
  app.get('/recent/:channel', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    try {
      const messages = agent.recent(req.params.channel, limit);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Thread ────────────────────────────────────────────────
  app.get('/thread/:threadId', (req, res) => {
    try {
      const messages = agent.thread(req.params.threadId);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Replies to a message ──────────────────────────────────
  app.get('/replies/:messageId', (req, res) => {
    try {
      const messages = agent.replies(req.params.messageId);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Context around a message ──────────────────────────────
  app.get('/context/:channel/:messageId', (req, res) => {
    const window = parseInt(req.query.window) || 10;
    try {
      const messages = agent.context(req.params.channel, req.params.messageId, window);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Messages by user ─────────────────────────────────────
  app.get('/user/:userId', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const channel = req.query.channel;
    const guild = req.query.guild;
    try {
      const messages = agent.userMessages(req.params.userId, { channel, guild, limit });
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Stats ─────────────────────────────────────────────────
  app.get('/stats', (_req, res) => {
    res.json(agent.stats());
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Agent query API listening on http://localhost:${port}`);
      console.log('Endpoints: POST /ask, POST /search, GET /guilds, GET /channels, GET /users, GET /recent/:ch, GET /thread/:id, GET /stats');
      resolve(server);
    });
  });
}
