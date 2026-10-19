/**
 * Slash commands backed by Markdown files, delivered through the skill
 * pipeline so they behave exactly like a skill in the composer.
 *
 * Every `*.md` file under the configured roots becomes a user-invocable skill
 * named after the file: `~/.agents/commands/handoff.md` is `/handoff`. Nothing
 * is discovered passively — the catalog never lists these entries to the model
 * (`modelInvocable: false`), there is no YAML frontmatter to write, and no
 * model-facing tool. The body is only read when the user explicitly types or
 * picks `/name`.
 *
 * Why the skill pipeline instead of a host command: a command executes the
 * moment the line is claimed, so its output is committed before the user can
 * reconsider. A skill pick only lands the literal `/name ` text in the
 * composer. The user keeps typing, sends one message, deletes the token to
 * cancel, and the host's own `agent/pre-step` boundary turns the gesture into
 * `<skill_content>` exactly once, at send time. Withdrawal therefore needs no
 * extra command: backspace is the withdrawal.
 *
 * Files are re-scanned on directory events and the provider invalidates its
 * catalog, so adding, removing, or editing a command refreshes the `/` menu
 * without a restart. Every decision is appended to
 * `%TEMP%\dsh-command-files.log`.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
export const name = 'command-files';

/** The skill registry is the only required service. */
export const inject = ['skills'];

/** This package directory, where `config.json` lives by default. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/** Provider label shown in discovery metadata and the debug log. */
const PROVIDER = 'command-files';

/**
 * Duplicate-name priority inside one registry layer: lower wins. Real skills
 * occupy 100-600 (project through bundled), so 700 keeps a user's skill in
 * front of a command file that happens to share its name.
 */
const RANK = 700;

/** Skill names: kebab-case, the shape the `/name` gesture grammar accepts. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Shipped defaults; the row config and `config.json` override them. */
const DEFAULTS = {
  enabled: true,
  /** Extra roots; empty keeps the default roots below. */
  dirs: [],
  includeDefaults: true,
  watch: true,
  maxBytes: 262144,
  descriptionMaxLength: 120,
  locale: 'zh',
  debugLog: true,
};

/** Built-in copy; `messages` in `config.json` may override it key by key. */
const BUILTIN_MESSAGES = {
  zh: {
    descriptionFallback: name => `自定义命令文件（/${name}）`,
  },
  en: {
    descriptionFallback: name => `Command file on disk (/${name})`,
  },
};

/** Resolve `~` against the OS home, mirroring the harness' own path rules. */
function expandHome(value) {
  if (typeof value !== 'string') return '';
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/** The shared agent configuration root (`$DSH_AGENTS_HOME` or `~/.agents`). */
function agentsHome() {
  const fromEnv = typeof process.env.DSH_AGENTS_HOME === 'string' ? process.env.DSH_AGENTS_HOME.trim() : '';
  return resolve(fromEnv === '' ? join(homedir(), '.agents') : expandHome(fromEnv));
}

/** Append one diagnostic line so a decision can be read back after the fact. */
function makeLogger(enabled) {
  if (!enabled) return () => {};
  const path = join(tmpdir(), 'dsh-command-files.log');
  return (line) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      /* logging must never break discovery */
    }
  };
}

/** Trim to `max` characters with a single ellipsis. */
function clip(text, max) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Strip an optional YAML frontmatter block. Frontmatter is never required; it
 * is tolerated so a file copied from a skill still loads without leaking its
 * header into the prompt.
 */
function stripFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (match === null) return text;
  return /^[A-Za-z0-9_-]+\s*:/mu.test(match[1]) ? text.slice(match[0].length) : text;
}

/** First heading or first non-empty line, stripped of light Markdown syntax. */
function deriveDescription(text, fallback, maxLength) {
  for (const line of stripFrontmatter(text).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(trimmed);
    const candidate = (heading === null ? trimmed : heading[1])
      .replace(/^[-*>]\s+/u, '')
      .replace(/[*_`~]+/gu, '')
      .trim();
    if (candidate !== '') return clip(candidate, maxLength);
  }
  return fallback;
}

/**
 * Normalize a relative Markdown file name into a skill name. Separators inside
 * nested directories and whitespace runs become `-`; anything outside the
 * `/name` gesture grammar is rejected rather than silently renamed.
 */
function toSkillName(stem) {
  const normalized = stem
    .toLowerCase()
    .replace(/[\\/]+/gu, '-')
    .replace(/[\s_]+/gu, '-')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return SKILL_NAME.test(normalized) ? normalized : undefined;
}

/** Recursively list `.md` files; nested directories join with `-` in the name. */
function listMarkdown(root) {
  const found = [];
  const walk = (directory, prefix) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path, `${prefix}${entry.name}-`);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
      found.push({ path, stem: `${prefix}${entry.name.slice(0, -3)}` });
    }
  };
  walk(root, '');
  return found;
}

/** Read one command file without trusting its size. */
function readCommandFile(path, maxBytes) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { missing: true };
  }
  if (!stats.isFile()) return { error: 'not a regular file' };
  if (stats.size > maxBytes) return { oversized: true };
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '').replace(/\s+$/u, '');
    return text.trim() === '' ? { empty: true } : { text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Mount the command-file skill provider for this profile.
 * @param ctx - host context; the `skills` service is required.
 * @param [config] - row config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const rowConfig = config ?? {};
  const configPath = typeof rowConfig.configPath === 'string' && rowConfig.configPath !== ''
    ? rowConfig.configPath
    : join(PACKAGE_DIR, 'config.json');

  /** mtime-cached `config.json`, so an edit applies to the next read. */
  let userCache = { mtimeMs: -1, value: null };
  const userConfig = () => {
    try {
      const stats = statSync(configPath);
      if (stats.mtimeMs !== userCache.mtimeMs) {
        userCache = { mtimeMs: stats.mtimeMs, value: JSON.parse(readFileSync(configPath, 'utf8')) };
      }
      return userCache.value ?? {};
    } catch {
      userCache = { mtimeMs: -1, value: null };
      return {};
    }
  };

  /** Resolve switches and copy now: both may have changed since the last use. */
  const resolveSettings = () => {
    const user = userConfig();
    const userSettings = user.settings !== null && typeof user.settings === 'object' ? user.settings : {};
    const options = { ...DEFAULTS, ...rowConfig, ...userSettings };
    delete options.configPath;
    const locale = options.locale === 'en' ? 'en' : 'zh';
    const userMessages = user.messages !== null && typeof user.messages === 'object' ? user.messages : {};
    const language = userMessages[locale] !== null && typeof userMessages[locale] === 'object' ? userMessages[locale] : {};
    return { options, messages: { ...BUILTIN_MESSAGES[locale], ...language } };
  };

  const log = makeLogger(resolveSettings().options.debugLog !== false);

  /** Roots in precedence order, deduplicated case-insensitively on Windows. */
  const resolveDirs = (options) => {
    const roots = [];
    if (options.includeDefaults !== false) {
      roots.push(join(agentsHome(), 'commands'), join(agentsHome(), 'command'));
    }
    if (Array.isArray(options.dirs)) {
      for (const value of options.dirs) {
        if (typeof value !== 'string' || value.trim() === '') continue;
        roots.push(resolve(expandHome(value.trim())));
      }
    }
    const seen = new Set();
    const unique = [];
    for (const root of roots) {
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(root);
    }
    return unique;
  };

  /** Scan every root; first root wins a duplicate name. */
  const discover = (options) => {
    const maxLength = Number.isInteger(options.descriptionMaxLength) && options.descriptionMaxLength > 0
      ? options.descriptionMaxLength
      : DEFAULTS.descriptionMaxLength;
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULTS.maxBytes;
    const fallbackDescription = resolveSettings().messages.descriptionFallback;
    const found = [];
    const taken = new Set();
    for (const root of resolveDirs(options)) {
      for (const file of listMarkdown(root)) {
        const name = toSkillName(file.stem);
        if (name === undefined) {
          log(`skip file=${file.path} reason=invalid-skill-name`);
          continue;
        }
        if (taken.has(name)) {
          log(`skip file=${file.path} reason=duplicate-name name=/${name}`);
          continue;
        }
        const loaded = readCommandFile(file.path, maxBytes);
        if (loaded.text === undefined) {
          log(`skip file=${file.path} reason=${loaded.missing === true ? 'missing' : loaded.oversized === true ? 'oversized' : 'unreadable'}`);
          continue;
        }
        taken.add(name);
        found.push({
          name,
          path: file.path,
          directory: dirname(file.path),
          description: deriveDescription(loaded.text, fallbackDescription(name), maxLength),
        });
      }
    }
    return found;
  };

  /** The provider's current invalidation handle, replaced on every registration. */
  let invalidateCatalog = () => {};
  /** Directories currently watched, keyed by absolute path. */
  const watchers = new Map();
  let timer;
  /** Last scan result, for the debug log and for `get()`'s missing-file message. */
  let current = new Map();

  /**
   * Provider candidates: user-invocable only. `modelInvocable: false` is what
   * keeps this out of the model's skill catalog — the model never learns these
   * commands exist until the user's own message carries the gesture.
   */
  const provider = {
    name: PROVIDER,
    async list() {
      const { options } = resolveSettings();
      if (options.enabled === false) return [];
      const entries = discover(options);
      current = new Map(entries.map(entry => [entry.name, entry]));
      return entries.map(entry => ({
        name: entry.name,
        description: entry.description,
        invocation: { modelInvocable: false, userInvocable: true },
        source: PROVIDER,
        provider: PROVIDER,
        rank: RANK,
        path: entry.path,
        locator: { path: entry.path, directory: entry.directory },
        resourceBase: { kind: 'directory', path: entry.directory },
      }));
    },
    async get(candidate) {
      const { options } = resolveSettings();
      if (options.enabled === false) return undefined;
      const locator = candidate.locator ?? {};
      const path = typeof locator.path === 'string' ? locator.path : undefined;
      if (path === undefined) return undefined;
      const loaded = readCommandFile(path, options.maxBytes);
      if (loaded.text === undefined) {
        log(`load-failed name=/${candidate.name} file=${path} reason=${loaded.missing === true ? 'missing' : loaded.oversized === true ? 'oversized' : 'unreadable'}`);
        return undefined;
      }
      log(`load name=/${candidate.name} file=${path} chars=${loaded.text.length}`);
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: { modelInvocable: false, userInvocable: true },
        source: PROVIDER,
        provider: PROVIDER,
        path,
        resourceBase: {
          kind: 'directory',
          path: typeof locator.directory === 'string' ? locator.directory : dirname(path),
        },
        content: stripFrontmatter(loaded.text),
      };
    },
  };

  const nearestExisting = (path) => {
    let candidate = resolve(path);
    while (true) {
      if (existsSync(candidate)) return candidate;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  };

  /**
   * One root plus every existing directory below it, bounded so a pathological
   * tree cannot hold the plugin open. A root that does not exist yet falls back
   * to its nearest existing ancestor, which reports its creation.
   */
  const watchTargets = (dir, depth = 0, out = []) => {
    if (depth > 8) return out;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      if (depth === 0) {
        const fallback = nearestExisting(dir);
        if (fallback !== undefined) out.push(fallback);
      }
      return out;
    }
    out.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      watchTargets(join(dir, entry.name), depth + 1, out);
    }
    return out;
  };

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        // Let the registry drop its cached catalog; the next `/` menu read and
        // the next printed step both discover from the live files.
        invalidateCatalog();
        log('invalidate reason=watch');
        ensureWatchers(resolveDirs(resolveSettings().options));
      } catch (error) {
        log(`invalidate-failed detail=${error instanceof Error ? error.message : String(error)}`);
      }
    }, 150);
    timer.unref?.();
  };

  const ensureWatchers = (dirs) => {
    if (resolveSettings().options.watch === false) return;
    for (const dir of dirs) {
      for (const target of watchTargets(dir)) {
        if (watchers.has(target)) continue;
        try {
          const watcher = watch(target, { persistent: false }, schedule);
          watcher.on('error', () => {
            watchers.delete(target);
            try {
              watcher.close();
            } catch {
              /* already closed */
            }
            schedule();
          });
          watchers.set(target, watcher);
        } catch (error) {
          log(`watch-failed dir=${target} detail=${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };

  ctx.effect(() => ctx.skills.registerProvider((control) => {
    invalidateCatalog = () => {
      try {
        control.invalidate();
      } catch (error) {
        log(`invalidate-threw detail=${error instanceof Error ? error.message : String(error)}`);
      }
    };
    ensureWatchers(resolveDirs(resolveSettings().options));
    return provider;
  }), 'dsh-command-files: skill provider and watchers');

  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    watchers.clear();
    current = new Map();
  }, 'dsh-command-files: close watchers');

  // One discovery at load time: proves the provider is wired and leaves a
  // readable trace of what the `/` menu will offer.
  try {
    const { options } = resolveSettings();
    const entries = options.enabled === false ? [] : discover(options);
    current = new Map(entries.map(entry => [entry.name, entry]));
    log(`ready dirs=${resolveDirs(options).join(';')} skills=${entries.map(entry => `/${entry.name}`).join(',') || '(none)'} config=${configPath} node=${process.version}`);
  } catch (error) {
    log(`ready-failed detail=${error instanceof Error ? error.message : String(error)}`);
  }
}
