// Wise Agent Pass hackathon demo. Entry point.
//
// One process runs two things that share the same state:
//   1. the MCP server over stdio, for Claude Desktop  (src/mcp.js)
//   2. the "Wise app" web page on http://localhost:4000  (src/web.js)
//
//   node index.js         both (this is what Claude Desktop runs)
//   node index.js --web   only the web app, no Claude needed (npm run web)
//
// IMPORTANT: stdout carries the MCP protocol. Never console.log(); use log() from src/log.js.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './src/mcp.js';
import { createWebApp, startWebServer } from './src/web.js';
import { log } from './src/log.js';

const PORT = Number(process.env.PORT) || 4000;
const WEB_ONLY = process.argv.includes('--web');

const httpServer = startWebServer(createWebApp(), PORT);

const shutdown = (why) => {
  log(`shutting down (${why})`);
  httpServer.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log('uncaught:', e));
process.on('unhandledRejection', (e) => log('unhandled:', e));

if (WEB_ONLY) {
  log('web-only mode: no MCP server. Press Ctrl+C to stop.');
} else {
  await createMcpServer().connect(new StdioServerTransport());
  log('MCP server connected over stdio');

  // Claude Desktop closes our stdin when it quits or restarts. Exit then, so no orphan
  // process keeps holding port 4000.
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
}
