# Discorder

Discord listener, historical importer, and RAG-like agent query interface. Captures Discord messages in real-time via the Gateway WebSocket, bulk-imports guild and channel history, stores everything in SQLite with FTS5 full-text search, and exposes an HTTP API for AI agents to query Discord context.

Inspired by [ktlyman/slacker](https://github.com/ktlyman/slacker) (same architecture adapted from Slack to Discord).

## Setup

```bash
npm install
```

Copy `.env.example` or create a `.env` file:

```
DISCORD_BOT_TOKEN=your-bot-token-here
DATABASE_PATH=discord-agent.db
```

### Authentication

Auth mode is auto-detected from environment variables (priority: bot > user).

**Bot mode** (recommended) requires a Discord application from the [Developer Portal](https://discord.com/developers/applications):
- Set `DISCORD_BOT_TOKEN` in `.env`
- Enable privileged intents: **Message Content** and **Server Members**

**User token mode** (one-time export only — against Discord TOS for automation):
- Set `DISCORD_USER_TOKEN` in `.env`

## Usage

The all-in-one command imports history, starts the real-time listener, and serves the query API:

```bash
node bin/cli.js serve
```

Or run components individually:

```bash
node bin/cli.js import              # Bulk-import historical messages
node bin/cli.js listen              # Start real-time Discord listener
node bin/cli.js query "search terms" # Search stored messages from the CLI
node bin/cli.js stats               # Show database statistics
node bin/cli.js channels            # List imported channels
node bin/cli.js guilds              # List imported guilds
```

Use `--no-threads` with `import` or `serve` to skip thread imports.

## HTTP API

Runs on port **3141** by default (configurable via `-p` flag or `AGENT_API_PORT` env var).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/ask` | Natural language query (returns hits + context) |
| `POST` | `/search` | Full-text search with filters |
| `GET` | `/guilds` | List guilds |
| `GET` | `/channels` | List channels (optional `?guild=` filter) |
| `GET` | `/recent/:channel` | Recent channel messages |
| `GET` | `/thread/:threadId` | Messages in a thread |
| `GET` | `/replies/:messageId` | Replies to a message |
| `GET` | `/context/:channel/:messageId` | Messages surrounding a specific message |
| `GET` | `/user/:userId` | Messages by user |
| `GET` | `/stats` | Database statistics |
| `GET` | `/health` | Health check with stats |

## Database

SQLite with WAL mode and FTS5 full-text search. The schema is auto-migrated on first run.

The importer captures: messages, threads, user profiles, member info (nicknames, roles), pins, roles, custom emoji, and guild metadata.

## License

MIT
