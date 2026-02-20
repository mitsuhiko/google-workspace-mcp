import vm from 'node:vm';
import * as nodeModule from 'node:module';
import util from 'node:util';

const { stripTypeScriptTypes } = nodeModule;

import {
  authorize,
  DEFAULT_SCOPES,
  DEFAULT_VERSIONS,
  getGoogleApis,
  loadToken,
  resolveAuthMode,
} from './google-auth.js';

function resolveMethod(root, methodPath) {
  const parts = String(methodPath)
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error('methodPath is empty');
  }

  let parent = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const segment = parts[index];
    parent = parent?.[segment];
    if (!parent) {
      throw new Error(`Invalid methodPath: missing segment \"${segment}\"`);
    }
  }

  const methodName = parts[parts.length - 1];
  const method = parent?.[methodName];

  if (typeof method !== 'function') {
    throw new Error(
      `Invalid methodPath: \"${methodPath}\" does not point to a callable method.`,
    );
  }

  return { parent, method };
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Execution timed out after ${Math.round(timeoutMs)}ms.`));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatLogArg(value) {
  if (typeof value === 'string') {
    return value;
  }

  return util.inspect(value, {
    depth: 6,
    maxArrayLength: 200,
    breakLength: 120,
    compact: 2,
  });
}

function createExecutionConsole(logs) {
  const write = (level, args) => {
    logs.push({
      level,
      message: args.map(formatLogArg).join(' '),
      timestamp: new Date().toISOString(),
    });
  };

  return {
    log: (...args) => write('log', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
  };
}

function normalizeForJson(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return `${value}n`;
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = normalizeForJson(nested, seen);
    }
    return output;
  }

  return value;
}

function serialize(value) {
  const normalized = normalizeForJson(value);
  try {
    return JSON.stringify(normalized, null, 2);
  } catch {
    return util.inspect(normalized, {
      depth: 8,
      maxArrayLength: 300,
      breakLength: 120,
      compact: false,
    });
  }
}

function normalizeTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) {
    return 30_000;
  }

  const numeric = Number(timeoutMs);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('timeoutMs must be a positive number.');
  }

  return Math.min(Math.floor(numeric), 5 * 60_000);
}

function prepareUserScript(script) {
  if (typeof stripTypeScriptTypes !== 'function') {
    return script;
  }

  try {
    return stripTypeScriptTypes(script, {
      mode: 'strip',
      sourceUrl: 'workspace-user-script.ts',
    });
  } catch (error) {
    const message = error?.message || String(error);
    throw new Error(`TypeScript stripping failed: ${message}`);
  }
}

function createWorkspaceHelper({ auth, googleApis }) {
  const workspace = {
    versions: { ...DEFAULT_VERSIONS },

    async call(service, methodPath, params = {}, options = {}) {
      const factory = googleApis?.[service];
      if (typeof factory !== 'function') {
        throw new Error(`Unknown Google API service: ${service}`);
      }

      const api = factory({
        version: options.version || DEFAULT_VERSIONS[service] || 'v1',
        auth,
      });

      const { parent, method } = resolveMethod(api, methodPath);
      const response = await method.call(parent, params);
      return response?.data ?? response;
    },

    service(service, options = {}) {
      const factory = googleApis?.[service];
      if (typeof factory !== 'function') {
        throw new Error(`Unknown Google API service: ${service}`);
      }

      return factory({
        version: options.version || DEFAULT_VERSIONS[service] || 'v1',
        auth,
      });
    },

    async whoAmI() {
      const oauth2 = googleApis.oauth2({ version: 'v2', auth });
      const response = await oauth2.userinfo.get();
      return response?.data ?? response;
    },
  };

  return workspace;
}

export class WorkspaceRuntime {
  constructor() {
    this.state = {};
  }

  resetState() {
    this.state = {};
  }

  async execute({ script, timeoutMs, scopes }) {
    if (typeof script !== 'string' || script.trim().length === 0) {
      throw new Error('script must be a non-empty string.');
    }

    const effectiveTimeout = normalizeTimeout(timeoutMs);

    const effectiveScopes =
      Array.isArray(scopes) && scopes.length > 0 ? scopes : DEFAULT_SCOPES;

    const auth = await authorize({
      interactive: true,
      scopes: effectiveScopes,
    });

    const googleApis = getGoogleApis();
    const workspace = createWorkspaceHelper({ auth, googleApis });
    const logs = [];

    const context = vm.createContext({
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      console: createExecutionConsole(logs),
      __api: {
        auth,
        google: googleApis,
        workspace,
        state: this.state,
      },
    });

    const executableScript = prepareUserScript(script);

    const wrappedScript = `
(async () => {
  const { auth, google, workspace, state } = __api;
  ${executableScript}
})()
`;

    try {
      const compiled = new vm.Script(wrappedScript, {
        filename: 'workspace-execute.js',
        displayErrors: true,
      });

      const resultPromise = Promise.resolve(
        compiled.runInContext(context, {
          timeout: Math.min(effectiveTimeout, 60_000),
          displayErrors: true,
        }),
      );

      const result = await withTimeout(resultPromise, effectiveTimeout);
      const token = loadToken();

      return {
        ok: true,
        authMode: resolveAuthMode(token),
        timeoutMs: effectiveTimeout,
        logs,
        result: normalizeForJson(result),
      };
    } catch (error) {
      error.executionLogs = logs;
      throw error;
    }
  }
}

export function formatExecutionOutput(value) {
  return serialize(value);
}

export function formatExecutionError(error) {
  return serialize({
    ok: false,
    error: {
      name: error?.name || 'Error',
      message: error?.message || 'Unknown error',
      stack: error?.stack || null,
    },
    logs: Array.isArray(error?.executionLogs) ? error.executionLogs : [],
  });
}
