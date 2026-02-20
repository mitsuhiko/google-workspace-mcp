# Google Workspace Code MCP

A local JavaScript/TypeScript MCP server with a **single tool**: `execute`.

`execute` runs JavaScript (or TypeScript with type stripping) and gives that code authenticated access to Google Workspace APIs.

## What this server does

- Exposes **one MCP tool**: `execute`
- Runs user-provided JavaScript/TypeScript (async function body; TS types stripped)
- Automatically performs OAuth login on first use (browser flow)
- Reuses stored tokens on subsequent calls
- Provides a small runtime API inside executed code:
  - `auth` — Google OAuth client
  - `google` — `googleapis` SDK root
  - `workspace` — helper methods (`call`, `service`, `whoAmI`)
  - `state` — persistent mutable object across calls

This follows a code-mode design: one flexible execution tool instead of many fixed tools.

## Requirements

- Node.js 20+
- Local desktop/browser access for the initial OAuth sign-in

## Install

```bash
npm install
```

## Run

```bash
npm start
```

or:

```bash
node src/server.js
```

## MCP configuration

This repo already includes `.mcp.json`:

```json
{
  "mcpServers": {
    "google-workspace-code": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/mitsuhiko/Development/workspace-mcp/src/server.js"
      ],
      "env": {
        "GOOGLE_WORKSPACE_AUTH_MODE": "cloud"
      }
    }
  }
}
```

If you move the project, update the `args` path.

## Tool contract

### Tool name

- `execute`

### Input schema

- `script` (string, required): JavaScript/TypeScript async function body (TS type syntax is stripped before execution)
- `timeoutMs` (number, optional): execution timeout in milliseconds (default `30000`, max `300000`)
- `scopes` (string[], optional): override OAuth scopes for the call
- `resetState` (boolean, optional): clears persistent `state` before execution

### Execution environment

Your script runs as an async function body with these variables in scope:

- `auth`
- `google`
- `workspace`
- `state`

Return values are serialized and sent back as tool output.

## Example scripts

### 1) Who am I + list Drive files

```js
const me = await workspace.whoAmI();
const files = await workspace.call('drive', 'files.list', {
  pageSize: 5,
  fields: 'files(id,name,mimeType)'
});

state.lastEmail = me.email;

return {
  user: me,
  files: files.files,
  remembered: state.lastEmail
};
```

### 2) List today’s calendar events

```js
const start = new Date();
start.setHours(0, 0, 0, 0);

const end = new Date(start);
end.setDate(end.getDate() + 1);

return await workspace.call('calendar', 'events.list', {
  calendarId: 'primary',
  timeMin: start.toISOString(),
  timeMax: end.toISOString(),
  singleEvents: true,
  orderBy: 'startTime'
});
```

## OAuth and token storage

- First call without token triggers browser login automatically
- Default config directory: `~/.pi/google-workspace`
- Default token path: `~/.pi/google-workspace/token.json`
- Default auth mode: `cloud` (unless overridden)

### Environment variables

- `GOOGLE_WORKSPACE_CONFIG_DIR`
- `GOOGLE_WORKSPACE_CREDENTIALS`
- `GOOGLE_WORKSPACE_TOKEN`
- `GOOGLE_WORKSPACE_AUTH_MODE` (`cloud` or `local`)
- `GOOGLE_WORKSPACE_CLIENT_ID`
- `GOOGLE_WORKSPACE_CLOUD_FUNCTION_URL`
- `GOOGLE_WORKSPACE_CALLBACK_HOST`

## Security notes

- Uses Node `vm` for execution convenience, **not a hardened sandbox**.
- Treat this as trusted local tooling.
- Do not expose this server to untrusted users or networks.
