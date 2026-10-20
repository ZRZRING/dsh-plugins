/**
 * Host half of the desktop-attention bundle.
 *
 * The dsh host runs in a child process without Electron APIs, so this plugin
 * speaks to the operating system directly, the same split Codex and ZCode use
 * with their own sound assets:
 * - a native toast through the Windows WinRT toast API (PowerShell host), or
 *   `notify-send` / `osascript` elsewhere;
 * - optionally one short sound played by the platform player.
 *
 * Triggers, all limited to root sessions so subagent churn stays silent:
 * - `agent/status` running -> idle  → the task finished
 * - `agent/error`                   → the task failed (10s per-session window)
 * - `user-questions/request`        → the agent is blocked on your answer
 * - `approval/request`              → the agent is blocked on your approval
 *
 * Copy and switches live in `config.json` beside this file and are re-read on
 * every trigger, so editing that file needs no reinstall. Every decision is
 * appended to `%TEMP%\dsh-desktop-notifications.log`.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shipped defaults; the row config and `config.json` override them. */
const DEFAULTS = {
  enabled: true,
  /** `always` notifies on every trigger; `off` silences the bundle. */
  mode: 'always',
  /** `ding` (a system sound file) | `system` (the configured scheme sound) | `none`. */
  sound: 'none',
  /** Absolute sound file path; wins over `sound` when it exists. */
  soundFile: '',
  /**
   * Toast identity. A registered Application User Model ID decides the app name
   * Windows shows; `Microsoft.Windows.PowerShell` is registered on every
   * Windows install, while `com.deepseek.dsh` only works once a shortcut
   * carrying it exists.
   */
  aumid: 'Microsoft.Windows.PowerShell',
  onComplete: true,
  onFailure: true,
  onWaiting: true,
  /** Notification copy language: `zh` or `en`. */
  locale: 'zh',
  debugLog: true,
  /** Also log every received trigger event, including filtered-out ones. */
  debugEvents: false,
  /** Fire one notification while this plugin activates — a smoke test. */
  announceOnStart: false,
};

/** Built-in copy; `messages` in `config.json` overrides it key by key. */
const BUILTIN_MESSAGES = {
  zh: {
    readyTitle: 'DSH · 桌面通知已就绪',
    readyBody: '任务完成、失败或等待确认时会收到通知',
    completeTitle: 'DSH · 任务完成',
    completeBody: '{subject} 已完成，等待你的下一步',
    failureTitle: 'DSH · 任务失败',
    failureBody: '{subject} 出错：{detail}',
    waitingTitle: 'DSH · 等待你的确认',
    waitingBody: '{subject} 正在等待：{detail}',
  },
  en: {
    readyTitle: 'DSH · Desktop notifications ready',
    readyBody: 'You will get a notification when a task finishes, fails, or waits for you',
    completeTitle: 'DSH · Task finished',
    completeBody: '{subject} finished and is waiting for you',
    failureTitle: 'DSH · Task failed',
    failureBody: '{subject} failed: {detail}',
    waitingTitle: 'DSH · Waiting for you',
    waitingBody: '{subject} is waiting: {detail}',
  },
};

/** Duplicate suppression window, matching ZCode's 3s task-notification guard. */
const DEDUPE_MS = 3000;
/** Per-session failure window: retries inside one turn must not stack toasts. */
const FAILURE_MS = 10000;
/** Longest inline detail kept in a notification body. */
const DETAIL_MAX = 140;

/** This package directory, where `config.json` lives by default. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

function truncate(text) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

function errorDetail(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return truncate(error);
  return truncate(typeof error.message === 'string' ? error.message : String(error));
}

/** A short, human-recognizable name for the session being reported. */
function subjectOf(agent) {
  const header = agent?.session?.header;
  const cwd = typeof header?.cwd === 'string' ? header.cwd : '';
  if (cwd !== '') {
    const folder = basename(cwd);
    if (folder !== '') return folder;
  }
  const id = typeof agent?.id === 'string' ? agent.id : '';
  return id === '' ? 'dsh' : `会话 ${id.slice(0, 8)}`;
}

/** Subagent sessions are real sessions; their turns must not ring a bell. */
function isChildSession(agent) {
  const header = agent?.session?.header;
  return header?.origin === 'subagent' || header?.parentSession !== undefined;
}

/** Windows keeps the classic sounds in %SystemRoot%\Media. */
function windowsMedia(name) {
  const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
    ? process.env.SystemRoot
    : 'C:\\Windows';
  return join(root, 'Media', name);
}

/** Quote one value as a PowerShell single-quoted literal. */
function ps(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

/** Fill `{subject}` / `{detail}` and drop a separator left dangling by no detail. */
function format(template, subject, detail) {
  const text = String(template ?? '')
    .replace(/\{subject\}/gu, subject)
    .replace(/\{detail\}/gu, detail);
  return text.replace(/[：:]\s*$/u, '').trim();
}

/** The resolved sound file for this configuration, or `''` for the scheme sound. */
function resolveSoundFile(sound, soundFile) {
  if (soundFile !== '' && existsSync(soundFile)) return soundFile;
  if (sound === 'ding') {
    const candidate = windowsMedia('ding.wav');
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * Build the delivery script for the current platform.
 *
 * The script is handed to the interpreter as one `-EncodedCommand` payload, so
 * notification copy may contain any character without quoting surprises.
 */
function scriptFor(platform, title, body, aumid, soundFile, withSound) {
  if (platform === 'win32') {
    const sound = withSound
      ? soundFile === ''
        ? '[System.Media.SystemSounds]::Asterisk.Play()'
        : `(New-Object Media.SoundPlayer ${ps(soundFile)}).PlaySync()`
      : '';
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '$shown = $false',
      'try {',
      '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
      '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
      '  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '  $texts = $xml.GetElementsByTagName("text")',
      `  $texts.Item(0).AppendChild($xml.CreateTextNode(${ps(title)})) | Out-Null`,
      `  $texts.Item(1).AppendChild($xml.CreateTextNode(${ps(body)})) | Out-Null`,
      '  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
      `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${ps(aumid)}).Show($toast)`,
      '  $shown = $true',
      '} catch { }',
      sound,
      'if ($shown) { "toast=shown" } else { "toast=unavailable" }',
    ].filter(line => line !== '').join('\n');
  }
  if (platform === 'darwin') {
    const sound = withSound ? ' sound name "Glass"' : '';
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}${sound}`;
    return `/usr/bin/osascript -e ${JSON.stringify(script)} >/dev/null 2>&1 && echo toast=shown || echo toast=unavailable`;
  }
  const hint = withSound && soundFile !== '' ? ' -h string:x-canonical-private-synchronous:dsh' : '';
  return `notify-send --app-name=DSH --urgency=normal${hint} ${JSON.stringify(title)} ${JSON.stringify(body)} >/dev/null 2>&1 && echo toast=shown || echo toast=unavailable`;
}

/**
 * Deliver one notification: native toast first, then the optional sound.
 * Delivery never throws into the trigger path.
 */
function deliver(options, title, body, log) {
  const platform = process.platform;
  const withSound = options.sound !== 'none';
  const soundFile = withSound ? resolveSoundFile(options.sound, options.soundFile) : '';
  const script = scriptFor(platform, title, body, options.aumid, soundFile, withSound);
  const command = platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')]
    : ['-c', script];
  try {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', (error) => {
      log(`deliver-failed ${errorDetail(error)}`);
    });
    child.on('close', () => {
      log(`delivered title=${JSON.stringify(title)} sound=${withSound ? `on:${soundFile === '' ? 'scheme' : soundFile}` : 'off'} ${out.trim()}`);
    });
    child.unref();
  } catch (error) {
    log(`deliver-threw ${errorDetail(error)}`);
  }
}

/** Append one diagnostic line so a decision can be read back after the fact. */
function makeLogger(enabled) {
  if (!enabled) return () => {};
  const path = join(tmpdir(), 'dsh-desktop-notifications.log');
  return (line) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      /* logging must never break the trigger path */
    }
  };
}

/**
 * Mount the attention policy for this profile.
 * @param ctx - host context; only event subscription is used.
 * @param [config] - row config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const rowConfig = config ?? {};
  const configPath = typeof rowConfig.configPath === 'string' && rowConfig.configPath !== ''
    ? rowConfig.configPath
    : join(PACKAGE_DIR, 'config.json');

  /** mtime-cached `config.json`, so an edit applies to the next notification. */
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

  /** Resolve switches and copy now: both may have changed since the last trigger. */
  const resolve = () => {
    const user = userConfig();
    const userSettings = user.settings !== null && typeof user.settings === 'object' ? user.settings : {};
    const options = { ...DEFAULTS, ...rowConfig, ...userSettings };
    delete options.configPath;
    const locale = options.locale === 'en' ? 'en' : 'zh';
    const userMessages = user.messages !== null && typeof user.messages === 'object' ? user.messages : {};
    const language = userMessages[locale] !== null && typeof userMessages[locale] === 'object' ? userMessages[locale] : {};
    return { options, messages: { ...BUILTIN_MESSAGES[locale], ...language } };
  };

  const log = makeLogger(resolve().options.debugLog !== false);

  /** `${kind}:${sessionId}` -> last show time. */
  const recent = new Map();
  /** sessionId -> last failure notification time. */
  const lastFailure = new Map();

  const show = (kind, sessionId, title, body) => {
    const { options } = resolve();
    if (options.enabled === false || options.mode === 'off') {
      log(`skip kind=${kind} session=${sessionId} reason=mode-off`);
      return;
    }
    const key = `${kind}:${sessionId}`;
    const now = Date.now();
    const previous = recent.get(key);
    if (previous !== undefined && now - previous < DEDUPE_MS) {
      log(`skip kind=${kind} session=${sessionId} reason=duplicate`);
      return;
    }
    recent.set(key, now);
    log(`show kind=${kind} session=${sessionId} title=${JSON.stringify(title)} body=${JSON.stringify(body)}`);
    deliver(options, title, body, log);
  };

  const report = (kind, agent, title, body) => {
    show(kind, typeof agent?.id === 'string' ? agent.id : 'unknown', title, body);
  };

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      if (agent === undefined) return;
      if (resolve().options.debugEvents === true) log(`event agent/status session=${agent.id} status=${status} child=${isChildSession(agent)}`);
      // `agent/status` is emitted only on a real transition, so `idle` always
      // means a running turn just ended — no need to have observed `running`.
      if (status !== 'idle') return;
      const { options, messages } = resolve();
      if (isChildSession(agent) || options.onComplete === false) return;
      report('complete', agent, messages.completeTitle, format(messages.completeBody, subjectOf(agent), ''));
    } catch (error) {
      log(`error stage=agent-status ${errorDetail(error)}`);
    }
  }, { global: true });

  ctx.on('agent/error', ({ agent, error }) => {
    try {
      const { options, messages } = resolve();
      if (agent === undefined) return;
      if (options.debugEvents === true) log(`event agent/error session=${agent.id} child=${isChildSession(agent)} detail=${JSON.stringify(errorDetail(error))}`);
      if (options.onFailure === false || isChildSession(agent)) return;
      const now = Date.now();
      const previous = lastFailure.get(agent.id);
      if (previous !== undefined && now - previous < FAILURE_MS) {
        log(`skip kind=failure session=${agent.id} reason=retry-window`);
        return;
      }
      lastFailure.set(agent.id, now);
      report('failure', agent, messages.failureTitle, format(messages.failureBody, subjectOf(agent), errorDetail(error)));
    } catch (caught) {
      log(`error stage=agent-error ${errorDetail(caught)}`);
    }
  }, { global: true });

  /**
   * The question waterfall answers the Web UI; this listener only reports and
   * passes through. It is PREPENDED because the answering bridge terminates the
   * chain without calling `next()`, so a listener appended after it never runs.
   */
  ctx.on('user-questions/request', (request, next) => {
    try {
      const { options, messages } = resolve();
      const agent = request?.agent;
      if (options.debugEvents === true) log(`event user-questions/request session=${agent?.id ?? 'unknown'} questions=${Array.isArray(request?.questions) ? request.questions.length : 0}`);
      if (options.onWaiting !== false) {
        const first = Array.isArray(request?.questions) ? request.questions[0] : undefined;
        const detail = truncate(first?.header ?? first?.question ?? '');
        if (agent === undefined) {
          show('waiting', 'unknown', messages.waitingTitle, format(messages.waitingBody, 'dsh', detail));
        } else if (!isChildSession(agent)) {
          report('waiting', agent, messages.waitingTitle, format(messages.waitingBody, subjectOf(agent), detail));
        }
      }
    } catch (error) {
      log(`error stage=user-questions ${errorDetail(error)}`);
    }
    return next();
  }, { global: true, prepend: true });

  /** Same prepended pass-through rule for approvals; a `never` policy never reaches here. */
  ctx.on('approval/request', (request, next) => {
    try {
      const { options, messages } = resolve();
      const agent = request?.agent;
      if (options.debugEvents === true) log(`event approval/request session=${agent?.id ?? 'unknown'} tool=${JSON.stringify(request?.toolName ?? '')}`);
      if (options.onWaiting !== false && agent !== undefined && !isChildSession(agent)) {
        const detail = truncate(request?.reason ?? request?.toolName ?? '');
        report('waiting', agent, messages.waitingTitle, format(messages.waitingBody, subjectOf(agent), detail));
      }
    } catch (error) {
      log(`error stage=approval ${errorDetail(error)}`);
    }
    return next();
  }, { global: true, prepend: true });

  const initial = resolve();
  log(`ready build=0.0.1 mode=${initial.options.mode} sound=${initial.options.sound} locale=${initial.options.locale} debugEvents=${initial.options.debugEvents === true} config=${configPath} node=${process.version}`);
  if (initial.options.announceOnStart === true) {
    show('startup', 'plugin', initial.messages.readyTitle, format(initial.messages.readyBody, '', ''));
  }
}
