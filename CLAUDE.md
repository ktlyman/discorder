# CLAUDE.md

## Commands

- `npm start` — run main entry point
- `node bin/cli.js serve` — import history, start listener, and serve query API (all-in-one)
- `node bin/cli.js import` — bulk-import historical messages only
- `node bin/cli.js listen` — start Discord listener only (Gateway WebSocket)
- `node bin/cli.js query "search terms"` — CLI search against stored data
- `node bin/cli.js stats` — show database statistics
- `node bin/cli.js channels` — list imported channels
- `node bin/cli.js guilds` — list imported guilds
- `npx claude-md-lint@1 . --fail-under 80` — lint CLAUDE.md (CI runs this on push/PR)

## Architecture

```
bin/cli.js              CLI entry point (Commander.js, 8 subcommands)
src/index.js            Library re-exports
src/auth/resolve.js     Detect auth mode from env vars (bot/user)
src/auth/client.js      Create discord.js Client with required intents
src/listener/index.js   Real-time Gateway listener (WebSocket via discord.js)
src/history/index.js    Bulk historical message importer
src/agent/query.js      DiscordAgent class — search, context, thread, ask
src/agent/server.js     Express HTTP API wrapping DiscordAgent
src/storage/db.js       SQLite layer — schema, FTS5, upsert/query helpers
```

## Code Conventions

- Language: JavaScript (ESM — `"type": "module"` in package.json)
- MUST use `import`/`export` syntax, never `require()`
- Node.js built-ins MUST use the `node:` prefix (e.g., `import path from 'node:path'`)
- Database access MUST go through `src/storage/db.js` helpers. MUST NOT write raw SQL outside that file; instead, add new helpers to `src/storage/db.js` and import them
- Environment variables SHOULD be loaded via `dotenv/config` in the CLI entry point only

## Security

- Credentials (`DISCORD_BOT_TOKEN`, `DISCORD_USER_TOKEN`) MUST NOT be committed
- Use a `.env` file locally (already in `.gitignore`)
- `DATABASE_PATH` — SQLite database file path (default: `discord-agent.db`)

## Database

SQLite with WAL mode and FTS5. Schema is auto-migrated on first `getDb()` call.
Tables: `guilds`, `channels`, `users`, `members`, `messages`, `import_cursors`,
`messages_fts` (virtual), `roles`, `pins`, `emoji`.
Triggers keep FTS in sync on INSERT/DELETE automatically.

The importer pulls: messages, threads, user profiles, member info (nicknames, roles),
pins, roles, custom emoji, and guild metadata. Use `--no-threads` to skip thread import.

## HTTP API

Runs on port 3141 (configurable via `-p` flag or `AGENT_API_PORT` env var). Key endpoints:
- `POST /ask` — natural language query (returns hits + surrounding context)
- `POST /search` — full-text search with filters
- `GET /guilds`, `GET /channels` — list guilds/channels
- `GET /recent/:channel` — recent channel messages
- `GET /thread/:threadId` — messages in a thread
- `GET /replies/:messageId` — replies to a message
- `GET /context/:channel/:messageId` — messages surrounding a specific message
- `GET /user/:userId` — messages by user
- `GET /stats` — database statistics
- `GET /health` — health check with stats
