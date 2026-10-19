/**
 * Slash commands backed by Markdown files.
 *
 * Each `*.md` file under the configured roots becomes a host slash command
 * named after the file: `~/.agents/commands/handoff.md` is `/handoff`. Unlike a
 * skill, nothing is discovered passively — there is no catalog, no YAML
 * frontmatter, and no model-facing tool. The file is only read when the user
 * explicitly invokes the command, and then its full text is injected into the
 * user prompt.
 *
 * Two invocation paths share the same body:
 * - a bare `/handoff` executes the registered host command, whose handler
 *   queues the file as one user message (`agent.followup`), and
 * - a `/handoff <extra>` line (or `/handoff` inside a longer prompt) is sent as
 *   ordinary prompt text, and this plugin's `agent/pre-step` listener appends
 *   the same rendering as injected instructions for that step.
 *
 * Files are re-scanned on directory events, so adding, removing, or editing a
 * command refreshes the `/` menu without a restart. Every decision is appended
 * to `%TEMP%\dsh-command-files.log`.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
export const name = 'command-files';

/** The host slash-command registry is the only required service. */
export const inject = ['commands'];

/** This package directory, where `config.json` lives by default. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/** Host command names: lowercase letter, then letters, digits, `_` or `-`. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

/** `/name` gesture inside claimed user text, whitespace-bounded. */
const GESTURE = /(^|\s)\/([a-z][a-z0-9_-]*)(?=[\s]|$)/gu;

/** Shipped defaults; the row config and `config.json` override them. */
const DEFAULTS = {
  enabled: true,
  /** Extra roots; empty keeps the default roots below. */
  dirs: [],
  includeDefaults: true,
  watch: true,
  maxBytes: 262144,
  descriptionMaxLength: 120,
  wrap: true,
  /** `false` queues the body for the next prompt; `true` sends it as a new turn. */
  immediate: false,
  locale: 'zh',
  debugLog: true,
};

/** Built-in copy; `messages` in `config.json` may override it key by key. */
const BUILTIN_MESSAGES = {
  zh: {
    loaded: (name, chars) => `已注入 /${name}（${chars} 字）。`,
    queued: (name, chars) => `已注入 /${name}（${chars} 字），会随你下一条消息一起发出；现在可以继续补充要求。`,
    empty: name => `/${name} 对应的 Markdown 文件是空的。`,
    missing: name => `/${name} 对应的 Markdown 文件已不存在。`,
    tooLarge: (name, limit) => `/${name} 的文件超过 ${limit} 字节上限，未注入。`,
    unreadable: (name, detail) => `读取 /${name} 失败：${detail}`,
    descriptionFallback: name => `自定义命令文件（/${name}）`,
  },
  en: {
    loaded: (name, chars) => `Injected /${name} (${chars} chars)`,
    queued: (name, chars) => `Injected /${name} (${chars} chars); it will be sent with your next message, so you can keep typing.`,
    empty: name => `The Markdown file for /${name} is empty.`,
    missing: name => `The Markdown file for /${name} no longer exists.`,
    tooLarge: (name, limit) => `The file for /${name} exceeds ${limit} bytes and was not injected.`,
    unreadable: (name, detail) => `Could not read /${name}: ${detail}`,
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
      /* logging must never break a command */
    }
  };
}

/** Trim to `max` characters with a single ellipsis. */
function clip(text, max) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/** Escape a value used inside an element attribute. */
function escapeAttr(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** Escape model-facing prose embedded inside the framing tags. */
function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
 * Normalize a relative Markdown file name into a host command name. Separators
 * inside nested directories and whitespace runs become `-`; anything outside
 * the host grammar is rejected rather than silently renamed.
 */
function toCommandName(stem) {
  const normalized = stem
    .toLowerCase()
    .replace(/[\\/]+/gu, '-')
    .replace(/[\s_]+/gu, '-')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return COMMAND_NAME.test(normalized) ? normalized : undefined;
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

/** Render one command body for the model, with its base directory for relative paths. */
function renderBlock(name, path, body) {
  return [
    `<command_content name="${escapeAttr(name)}">`,
    '<command_resources>',
    `Base directory for this command: ${escapeText(dirname(path))}`,
    'Resolve relative paths mentioned by this command against the base directory before using them.',
    '</command_resources>',
    '',
    '<command_instructions>',
    body,
    '</command_instructions>',
    '</command_content>',
  ].join('\n');
}

/** Build one user-role message carrying injected command text. */
function commandMessage(name, text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'command-file', name },
  };
}

/**
 * Mount the command-file registry for this profile.
 * @param ctx - host context; the `commands` service is required.
 * @param [config] - row config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const rowConfig = config ?? {};
  const configPath = typeof rowConfig.configPath === 'string' && rowConfig.configPath !== ''
    ? rowConfig.configPath
    : join(PACKAGE_DIR, 'config.json');

  /** mtime-cached `config.json`, so an edit applies to the next scan/invocation. */
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
        const name = toCommandName(file.stem);
        if (name === undefined) {
          log(`skip file=${file.path} reason=invalid-command-name`);
          continue;
        }
        if (taken.has(name)) {
          log(`skip file=${file.path} reason=duplicate-name name=/${name}`);
          continue;
        }
        const loaded = readCommandFile(file.path, maxBytes);
        if (loaded.text === undefined) {
          log(`skip file=${file.path} reason=unreadable`);
          continue;
        }
        taken.add(name);
        found.push({
          name,
          path: file.path,
          description: deriveDescription(loaded.text, fallbackDescription(name), maxLength),
        });
      }
    }
    return found;
  };

  /** Live command set, shared by the command handlers and the gesture listener. */
  let current = new Map();
  /** Registered commands: name -> { path, description, dispose }. */
  const registered = new Map();

  const disposeAll = () => {
    for (const entry of registered.values()) {
      try {
        entry.dispose();
      } catch (error) {
        log(`dispose-failed name=/${entry.name ?? '?'} detail=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    registered.clear();
  };

  /**
   * Load one command body and render it for injection.
   * @returns `{ text, entry, chars, messages }` on success, `{ error }` when the
   *   file is missing, empty, oversized, or unreadable.
   */
  const prepare = (name, rawInput) => {
    // Reconcile first: a config edit or a file added while the menu was open
    // must apply to this very invocation, not only to the next watcher event.
    try {
      sync();
    } catch (error) {
      log(`invoke-rescan-failed detail=${error instanceof Error ? error.message : String(error)}`);
    }
    const entry = current.get(name);
    const { options, messages } = resolveSettings();
    if (entry === undefined) return { error: messages.missing(name) };
    const loaded = readCommandFile(entry.path, options.maxBytes);
    if (loaded.text === undefined) {
      if (loaded.missing === true) return { error: messages.missing(name) };
      if (loaded.oversized === true) return { error: messages.tooLarge(name, options.maxBytes) };
      if (loaded.empty === true) return { error: messages.empty(name) };
      return { error: messages.unreadable(name, loaded.error) };
    }
    const rendered = options.wrap === false
      ? stripFrontmatter(loaded.text)
      : renderBlock(name, entry.path, stripFrontmatter(loaded.text));
    const extra = typeof rawInput === 'string' ? rawInput.trim() : '';
    return {
      entry,
      text: extra === '' ? rendered : `${rendered}\n\n${extra}`,
      chars: loaded.text.length,
      messages,
      /** `false` queues the body for the user's next prompt; `true` starts a turn now. */
      immediate: options.immediate === true,
    };
  };

  /** Reconcile the registered command set with the scanned files. */
  const sync = () => {
    const { options } = resolveSettings();
    if (options.enabled === false) {
      disposeAll();
      current = new Map();
      return;
    }
    const entries = discover(options);
    const next = new Map(entries.map(entry => [entry.name, entry]));

    for (const [name, previous] of [...registered]) {
      const entry = next.get(name);
      if (entry !== undefined && entry.path === previous.path && entry.description === previous.description) continue;
      previous.dispose();
      registered.delete(name);
    }

    for (const [name, entry] of next) {
      if (registered.has(name)) continue;
      try {
        const dispose = ctx.commands.register({
          name,
          description: entry.description,
          handler: ({ agent, rawInput }) => {
            const invocation = prepare(name, rawInput);
            if (invocation.error !== undefined) return { kind: 'error', text: invocation.error };
            const message = commandMessage(name, invocation.text);
            // Queue by default: `inject` adds model-facing context without waking
            // the driver, so the body rides along with the next prompt the user
            // sends and they can keep typing first. `immediate` sends it now.
            if (invocation.immediate) agent.followup(message);
            else agent.inject(message);
            log(`inject path=menu name=/${name} mode=${invocation.immediate ? 'send' : 'queue'} file=${entry.path} chars=${invocation.chars} extra=${String(rawInput ?? '').trim().length}`);
            return {
              kind: 'success',
              text: invocation.immediate
                ? invocation.messages.loaded(name, invocation.chars)
                : invocation.messages.queued(name, invocation.chars),
            };
          },
        });
        registered.set(name, { name, path: entry.path, description: entry.description, dispose });
      } catch (error) {
        log(`register-failed name=/${name} detail=${error instanceof Error ? error.message : String(error)}`);
      }
    }

    current = next;
    ensureWatchers(resolveDirs(options));
    log(`scan dirs=${resolveDirs(options).join(';')} commands=${[...next.keys()].map(name => `/${name}`).join(',') || '(none)'}`);
  };

  /**
   * A `/name <extra>` line that the composer did not claim — or a `/name`
   * mention inside a longer prompt — reaches the model as ordinary user text.
   * Append the same rendered body as injected instructions for that step.
   */
  ctx.on('agent/pre-step', async ({ messages: batch, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    if (signal?.aborted === true) return decision;
    const names = [];
    for (const message of batch) {
      if (message?.source?.kind !== 'user') continue;
      for (const block of message.content ?? []) {
        if (block?.type !== 'text') continue;
        for (const match of String(block.text).matchAll(GESTURE)) {
          const name = match[2];
          if (name !== undefined && !names.includes(name)) names.push(name);
        }
      }
    }
    if (names.length === 0) return decision;
    const { options, messages } = resolveSettings();
    const injections = [];
    for (const name of names) {
      if (!current.has(name)) continue;
      const invocation = prepare(name, '');
      if (invocation.error !== undefined) continue;
      injections.push(commandMessage(name, invocation.text));
      log(`inject path=gesture name=/${name} file=${invocation.entry.path} chars=${invocation.chars}`);
    }
    if (injections.length === 0) return decision;
    return { ...decision, messages: [...decision.messages, ...injections] };
  });

  /** Host watchers, one per nearest existing directory. */
  const watchers = new Map();
  let timer;

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
        sync();
      } catch (error) {
        log(`scan-failed detail=${error instanceof Error ? error.message : String(error)}`);
      }
    }, 150);
    timer.unref?.();
  };

  const ensureWatchers = (dirs) => {
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

  sync();

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
    disposeAll();
    current = new Map();
  }, 'dsh-command-files: close watchers and unregister commands');

  const initial = resolveSettings();
  log(`ready dirs=${resolveDirs(initial.options).join(';')} commands=${[...current.keys()].map(name => `/${name}`).join(',') || '(none)'} config=${configPath} node=${process.version}`);
}
