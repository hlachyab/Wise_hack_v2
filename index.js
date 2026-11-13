// Wise MCP, "AI Mandate" hackathon demo. Entry point.
//
// One process runs two things that share the same state:
//   1. the MCP server over stdio, for Claude Desktop  (src/mcp.js)
//   2. the "Wise app" web page on http://localhost:4000  (src/web.js)
//
// IMPORTANT: stdout carries the MCP protocol. Never console.log(); use log() from src/log.js.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './src/mcp.js';
import { createWebApp, startWebServer } from './src/web.js';
import { log } from './src/log.js';

const PORT = Number(process.env.PORT) || 4000;

const httpServer = startWebServer(createWebApp(), PORT);

await createMcpServer().connect(new StdioServerTransport());
log('MCP server connected over stdio');

// Claude Desktop closes our stdin when it quits or restarts. Exit then, so no orphan
// process keeps holding port 4000.
const shutdown = (why) => {
  log(`shutting down (${why})`);
  httpServer.close();
  process.exit(0);
};
process.stdin.on('end', () => shutdown('stdin closed'));
process.stdin.on('close', () => shutdown('stdin closed'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (e) => log('uncaught:', e));
process.on('unhandledRejection', (e) => log('unhandled:', e));
