// stdout carries the MCP JSON-RPC protocol, so it must stay clean.
// Never use console.log() anywhere in this project. Log to stderr with log().
export const log = (...args) => console.error('[wise-mcp]', ...args);
