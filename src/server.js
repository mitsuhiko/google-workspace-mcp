#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { DEFAULT_SCOPES } from './google-auth.js';
import {
  WorkspaceRuntime,
  formatExecutionError,
  formatExecutionOutput,
} from './runtime.js';

const runtime = new WorkspaceRuntime();

const server = new McpServer({
  name: 'google-workspace-code-mcp',
  version: '0.1.0',
});

server.registerTool(
  'execute',
  {
    title: 'Execute JavaScript/TypeScript',
    description:
      'Execute JavaScript/TypeScript inside a Node vm context with authenticated Google Workspace access. ' +
      'TypeScript type syntax is stripped before execution. ' +
      'The script runs inside an async function body and can use: auth, google, workspace, state. ' +
      'Return values with `return ...`.',
    inputSchema: {
      script: z
        .string()
        .min(1)
        .describe(
          'JavaScript/TypeScript async function body. Type syntax is stripped before execution. Available variables: auth, google, workspace, state.',
        ),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(300000)
        .optional()
        .describe('Execution timeout in milliseconds (default: 30000).'),
      scopes: z
        .array(z.string())
        .optional()
        .describe(
          'Optional OAuth scopes override. Defaults to broad Google Workspace scopes.',
        ),
      resetState: z
        .boolean()
        .optional()
        .describe('Reset persistent `state` object before execution.'),
    },
  },
  async ({ script, timeoutMs, scopes, resetState }) => {
    if (resetState) {
      runtime.resetState();
    }

    try {
      const result = await runtime.execute({
        script,
        timeoutMs,
        scopes,
      });

      return {
        content: [
          {
            type: 'text',
            text: formatExecutionOutput(result),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: formatExecutionError(error),
          },
        ],
      };
    }
  },
);

function printHelp() {
  console.log(`google-workspace-code-mcp

Single-tool MCP server exposing one tool: execute

Tool input:
  - script (string, required, JavaScript/TypeScript)
  - timeoutMs (number, optional)
  - scopes (string[], optional)
  - resetState (boolean, optional)

Script runtime variables:
  - auth      -> authenticated Google OAuth client
  - google    -> googleapis package root
  - workspace -> helper with call/service/whoAmI
  - state     -> persistent mutable object across calls

The first call automatically triggers OAuth login if no token exists.
Token storage defaults to ~/.pi/google-workspace/token.json

Default scopes:
${DEFAULT_SCOPES.map((scope) => `  - ${scope}`).join('\n')}
`);
}

async function main() {
  if (
    process.argv.includes('--help') ||
    process.argv.includes('-h') ||
    process.argv.includes('help')
  ) {
    printHelp();
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('google-workspace-code-mcp is running on stdio');
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
