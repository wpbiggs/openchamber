import type { OpenChamberProjectAction } from './openchamberConfig';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

export type DevServerInfo = {
  command: string;
  label: string;
  /** Directory the command should run in. Defaults to the root directory passed to detect. */
  cwd?: string;
  actionId?: string;
  previewUrlHint?: string;
};

const DEV_COMMAND_PATTERNS = [
  { pattern: /^dev(:.*)?$/i },
  { pattern: /^start(:.*)?$/i },
  { pattern: /^preview(:.*)?$/i },
  { pattern: /^serve(:.*)?$/i },
  { pattern: /^develop(:.*)?$/i },
];

const COMMON_DEV_COMMANDS = [
  'dev',
  'start',
  'preview',
  'serve',
];

// Common monorepo layout roots. We probe each shallowly (one level deep) for
// child package.json files containing a dev-like script.
const MONOREPO_ROOTS = ['apps', 'packages', 'web', 'frontend', 'client', 'site', 'sites', 'examples'];

// Cap how many subdirs we scan to avoid runaway listing on giant repos.
const MAX_MONOREPO_SCAN = 40;

/**
 * Detect the dev server command from project actions or package.json scripts.
 * Returns the single best candidate. For monorepos with multiple apps, prefer
 * `findDevServerCandidates` so the caller can offer a picker.
 */
export async function detectDevServerCommand(
  directory: string,
  projectActions: OpenChamberProjectAction[],
  packageJsonScripts: Record<string, string> | null,
): Promise<DevServerInfo | null> {
  const candidates = await findDevServerCandidates(directory, projectActions, packageJsonScripts);
  return candidates[0] ?? null;
}

/**
 * Return every plausible dev-server candidate for a directory. Useful for
 * monorepos: the caller can show a picker if more than one is found.
 *
 * Discovery order (first non-empty wins, except project actions which always
 * take precedence):
 *   1. Project actions matching dev-like names
 *   2. Root package.json dev script
 *   3. package.json dev scripts in common monorepo subdirs (apps/*, packages/*, ...)
 *   4. Static index.html at the root (Python http.server fallback)
 */
export async function findDevServerCandidates(
  directory: string,
  projectActions: OpenChamberProjectAction[],
  packageJsonScripts: Record<string, string> | null,
): Promise<DevServerInfo[]> {
  if (!directory) return [];

  const results: DevServerInfo[] = [];

  // 1. Project actions
  const devActions = findDevServerActions(projectActions);
  for (const action of devActions) {
    results.push({
      command: action.command,
      label: action.name || 'Start Preview',
      actionId: action.id,
    });
  }

  // 2. Root package.json
  if (packageJsonScripts) {
    const devScript = findDevScript(packageJsonScripts);
    if (devScript) {
      results.push({
        command: `${packageManagerRunCommand()} ${devScript}`,
        label: `Start (${devScript})`,
        cwd: directory,
      });
    }
  }

  // 3. Monorepo subdirs — only worth scanning when the root has no dev script.
  if (!results.some((c) => c.cwd === directory)) {
    const monorepoCandidates = await scanMonorepoCandidates(directory);
    results.push(...monorepoCandidates);
  }

  // 4. Static fallback — only if nothing else turned up.
  if (results.length === 0 && (await hasStaticIndexHtml(directory))) {
    const port = await allocatePreviewPort();
    const resolvedPort = typeof port === 'number' && Number.isFinite(port) && port > 0 ? port : 8000;
    results.push({
      command: `python3 -m http.server ${resolvedPort}`,
      label: 'Static preview',
      cwd: directory,
      previewUrlHint: `http://127.0.0.1:${resolvedPort}/`,
    });
  }

  return results;
}

async function scanMonorepoCandidates(rootDirectory: string): Promise<DevServerInfo[]> {
  const subdirs = await collectCandidateSubdirs(rootDirectory);
  if (subdirs.length === 0) return [];

  const results: DevServerInfo[] = [];
  let scanned = 0;

  for (const subdir of subdirs) {
    if (scanned >= MAX_MONOREPO_SCAN) break;
    scanned += 1;

    const scripts = await readPackageJsonScripts(subdir);
    if (!scripts) continue;
    const devScript = findDevScript(scripts);
    if (!devScript) continue;

    const relative = relativePath(rootDirectory, subdir);
    results.push({
      command: `${packageManagerRunCommand()} ${devScript}`,
      label: relative ? `${relative} (${devScript})` : `Start (${devScript})`,
      cwd: subdir,
    });
  }

  return results;
}

async function collectCandidateSubdirs(rootDirectory: string): Promise<string[]> {
  const direct = await listChildDirectories(rootDirectory);
  const collected: string[] = [];
  const seen = new Set<string>();

  const push = (entry: string) => {
    if (!seen.has(entry)) {
      seen.add(entry);
      collected.push(entry);
    }
  };

  // Direct children that look like an app (package.json in them).
  for (const child of direct) {
    push(child);
  }

  // One level into each well-known monorepo container directory.
  for (const root of MONOREPO_ROOTS) {
    const containerPath = joinPath(rootDirectory, root);
    if (!direct.includes(containerPath)) continue;
    const grandchildren = await listChildDirectories(containerPath);
    for (const child of grandchildren) {
      push(child);
    }
  }

  return collected;
}

async function listChildDirectories(directory: string): Promise<string[]> {
  const runtimeFiles = getRegisteredRuntimeAPIs()?.files;

  if (runtimeFiles?.listDirectory) {
    try {
      const result = await runtimeFiles.listDirectory(directory, { respectGitignore: true });
      return result.entries
        .filter((entry) => entry.isDirectory && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map((entry) => entry.path);
    } catch {
      return [];
    }
  }

  try {
    const response = await fetch(
      `/api/fs/list?path=${encodeURIComponent(directory)}&respectGitignore=true`,
      { cache: 'no-store' },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as {
      entries?: Array<{ name: string; path: string; isDirectory: boolean }>;
    } | null;
    if (!body?.entries) return [];
    return body.entries
      .filter((entry) => entry.isDirectory && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

function joinPath(base: string, segment: string): string {
  if (!base) return segment;
  const normalized = base.replace(/[/\\]+$/, '');
  return `${normalized}/${segment}`;
}

function relativePath(root: string, child: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedChild = child.replace(/\\/g, '/');
  if (normalizedChild.startsWith(`${normalizedRoot}/`)) {
    return normalizedChild.slice(normalizedRoot.length + 1);
  }
  return normalizedChild;
}

async function hasStaticIndexHtml(directory: string): Promise<boolean> {
  const target = `${directory}/index.html`;
  const runtimeFiles = getRegisteredRuntimeAPIs()?.files;

  if (runtimeFiles?.readFile) {
    try {
      const result = await runtimeFiles.readFile(target);
      return typeof result?.content === 'string' && result.content.length > 0;
    } catch {
      return false;
    }
  }

  try {
    const response = await fetch(`/api/fs/read?path=${encodeURIComponent(target)}&optional=true`, {
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const text = await response.text();
    return text.trim().length > 0;
  } catch {
    return false;
  }
}

async function allocatePreviewPort(): Promise<number | null> {
  try {
    const response = await fetch('/api/system/free-port', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { port?: unknown } | null;
    const port = typeof body?.port === 'number' ? body.port : null;
    return port && Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

/**
 * Find every project action that looks like a dev server.
 */
function findDevServerActions(actions: OpenChamberProjectAction[]): OpenChamberProjectAction[] {
  const matched: OpenChamberProjectAction[] = [];
  for (const action of actions) {
    const nameAndCommand = `${action.name} ${action.command}`.toLowerCase();
    if (COMMON_DEV_COMMANDS.some((cmd) => nameAndCommand.includes(cmd))) {
      matched.push(action);
    }
  }
  // Preserve the previous fallback: if exactly one action exists and nothing
  // matched explicitly, treat it as the dev action.
  if (matched.length === 0 && actions.length === 1) {
    return [actions[0]];
  }
  return matched;
}

/**
 * Find a dev script in package.json scripts
 */
function findDevScript(scripts: Record<string, string>): string | null {
  for (const { pattern } of DEV_COMMAND_PATTERNS) {
    for (const scriptName of Object.keys(scripts)) {
      if (pattern.test(scriptName)) {
        return scriptName;
      }
    }
  }
  return null;
}

function packageManagerRunCommand(): string {
  // Client-side detection is intentionally simple. The server-side terminal
  // resolves the actual binary; `npm run` is portable across project types.
  return 'npm run';
}

/**
 * Read package.json scripts from a directory
 */
export async function readPackageJsonScripts(directory: string): Promise<Record<string, string> | null> {
  try {
    const target = `${directory}/package.json`;

    // Prefer runtime files API (desktop/VS Code). This avoids relying on the web
    // server exposing /api/fs/* when the UI is hosted elsewhere.
    const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
    const content = runtimeFiles?.readFile
      ? (await runtimeFiles.readFile(target)).content
      : await (async () => {
          const response = await fetch(`/api/fs/read?path=${encodeURIComponent(target)}&optional=true`, {
            // Avoid conditional requests (304 + empty body breaks JSON parsing).
            cache: 'no-store',
          });
          if (!response.ok) return null;
          return response.text();
        })();

    if (content == null) return null;
    const pkg = JSON.parse(content);

    return pkg.scripts || null;
  } catch {
    return null;
  }
}
