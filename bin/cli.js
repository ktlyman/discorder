#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { startListener } from '../src/listener/index.js';
import { importHistory } from '../src/history/index.js';
import { DiscordAgent } from '../src/agent/query.js';
import { startServer } from '../src/agent/server.js';
import { getDb, closeDb } from '../src/storage/db.js';
import { resolveAuth } from '../src/auth/resolve.js';
import { createClient, loginClient } from '../src/auth/client.js';

const program = new Command();

program
  .name('discord-agent')
  .description('Discord listener, history importer, and agent query interface')
  .version('1.0.0');

// ── listen ────────────────────────────────────────────────────
program
  .command('listen')
  .description('Start the real-time Discord message listener')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('--with-api', 'also start the agent query HTTP API')
  .option('-p, --port <number>', 'API port (default 3141)', parseInt)
  .action(async (opts) => {
    const auth = resolveAuth();
    console.log(`Auth mode: ${auth.mode}`);

    const onMessage = (m) => {
      const tag = m.type === 'edited' ? '(edited)' : '';
      console.log(`[${m.channelId}] ${m.author}: ${m.content} ${tag}`);
    };

    await startListener({
      token: auth.token,
      dbPath: opts.db,
      onMessage,
    });

    if (opts.withApi) {
      await startServer({ dbPath: opts.db, port: opts.port });
    }
  });

// ── import ────────────────────────────────────────────────────
program
  .command('import')
  .description('Import historical messages from Discord')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-g, --guilds <ids...>', 'specific guild IDs or names to import')
  .option('-c, --channels <names...>', 'specific channel names or IDs to import')
  .option('--no-threads', 'skip importing thread history')
  .option('--concurrency <n>', 'parallel channel imports (default 2)', parseInt)
  .action(async (opts) => {
    const auth = resolveAuth();
    console.log(`Auth mode: ${auth.mode}`);

    await importHistory({
      token: auth.token,
      dbPath: opts.db,
      guilds: opts.guilds,
      channels: opts.channels,
      includeThreads: opts.threads,
      concurrency: opts.concurrency,
    });
    closeDb();
  });

// ── serve (all-in-one: import → listen → API) ────────────────
program
  .command('serve')
  .description('Import history, start listener, and serve the query API')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-p, --port <number>', 'API port (default 3141)', parseInt)
  .option('-g, --guilds <ids...>', 'specific guild IDs or names to import')
  .option('-c, --channels <names...>', 'specific channel names or IDs to import')
  .option('--no-threads', 'skip importing thread history')
  .option('--skip-import', 'skip the initial history import')
  .action(async (opts) => {
    const auth = resolveAuth();
    console.log(`Auth mode: ${auth.mode}`);

    // Create a shared client for import + listen
    const { createClient, loginClient } = await import('../src/auth/client.js');
    const client = createClient(auth);
    await loginClient(client, auth.token);

    if (!opts.skipImport) {
      console.log('Step 1/3: Importing history...');
      await importHistory({
        client,
        dbPath: opts.db,
        guilds: opts.guilds,
        channels: opts.channels,
        includeThreads: opts.threads,
      });
    } else {
      console.log('Step 1/3: Skipping import (--skip-import)');
    }

    console.log('\nStep 2/3: Starting listener...');
    const onMessage = (m) => {
      console.log(`[live] #${m.channelId} ${m.author}: ${m.content}`);
    };

    // The client is already logged in, so we pass it directly
    // and re-register event handlers via startListener
    await startListener({
      client,
      token: auth.token,
      dbPath: opts.db,
      onMessage,
    });

    console.log('\nStep 3/3: Starting query API...');
    await startServer({ dbPath: opts.db, port: opts.port });
  });

// ── query (interactive CLI) ──────────────────────────────────
program
  .command('query <question>')
  .description('Ask a question against stored Discord data (CLI mode)')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-k, --top-k <number>', 'number of top results', parseInt, 5)
  .option('-c, --channel <name>', 'filter to a channel')
  .option('-g, --guild <name>', 'filter to a guild')
  .option('-u, --user <id>', 'filter to a user')
  .action((question, opts) => {
    const agent = new DiscordAgent({ dbPath: opts.db });
    const result = agent.ask(question, {
      topK: opts.topK,
      channel: opts.channel,
      guild: opts.guild,
      user: opts.user,
    });
    console.log('\n=== Search Results ===\n');
    for (const hit of result.hits) {
      const user = hit.user || 'unknown';
      const ch = hit.channel || '?';
      const guild = hit.guild || '?';
      console.log(`[${guild}] #${ch} | ${user}: ${hit.content}`);
      if (hit.created_at) console.log(`  ${hit.created_at}`);
      console.log();
    }
    console.log(`--- ${result.hits.length} hits | ${Object.keys(result.context).length} context blocks ---`);
    console.log(`DB: ${result.stats.messages} messages, ${result.stats.channels} channels, ${result.stats.users} users, ${result.stats.guilds} guilds\n`);
    closeDb();
  });

// ── stats ─────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show database statistics')
  .option('-d, --db <path>', 'path to SQLite database')
  .action((opts) => {
    const agent = new DiscordAgent({ dbPath: opts.db });
    const stats = agent.stats();
    console.log('\nDiscord Agent Database Stats');
    console.log(`  Messages:  ${stats.messages}`);
    console.log(`  Channels:  ${stats.channels}`);
    console.log(`  Users:     ${stats.users}`);
    console.log(`  Guilds:    ${stats.guilds}`);
    console.log(`  Threads:   ${stats.threads}`);
    console.log();
    closeDb();
  });

// ── channels ──────────────────────────────────────────────────
program
  .command('channels')
  .description('List all imported channels')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-g, --guild <name>', 'filter to a guild')
  .action((opts) => {
    const agent = new DiscordAgent({ dbPath: opts.db });
    const channels = agent.channels(opts.guild);
    for (const ch of channels) {
      const prefix = ch.type === 0 ? '#' : (ch.type === 2 ? 'V' : ' ');
      console.log(`${prefix} ${ch.name} (${ch.id})${ch.topic ? ' -- ' + ch.topic : ''}`);
    }
    console.log(`\n${channels.length} channels total`);
    closeDb();
  });

// ── guilds ───────────────────────────────────────────────────
program
  .command('guilds')
  .description('List all imported guilds')
  .option('-d, --db <path>', 'path to SQLite database')
  .action((opts) => {
    const agent = new DiscordAgent({ dbPath: opts.db });
    const guilds = agent.guilds();
    for (const g of guilds) {
      console.log(`  ${g.name} (${g.id}) — ${g.member_count} members`);
    }
    console.log(`\n${guilds.length} guilds total`);
    closeDb();
  });

program.parse();
