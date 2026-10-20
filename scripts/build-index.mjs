#!/usr/bin/env node
/**
 * 由 market/config.json + packages/&lt;pkg&gt;/package.json 生成 DSH 插件市场索引（格式 1）。
 *
 *   node scripts/build-index.mjs           生成 market/index.json
 *   node scripts/build-index.mjs --pin     把 git 来源的 "commit": "HEAD" 固化成当前 HEAD
 *   node scripts/build-index.mjs --check   CI：校验，并确认 index.json 与当前配置一致
 *
 * git 来源必须钉死 40 位 commit，所以发版顺序是：
 *   1. 改插件 → commit（这个 commit 里就有新代码）
 *   2. npm run pin   ← 把上面的 commit 写进 market/config.json
 *   3. npm run build → 提交 config + index.json
 *
 * 能解析到 @deepseek-ai/dsh-plugin-market-index 时用 DSH 官方校验器做最终把关。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const wantCheck = argv.includes('--check')
const wantPin = argv.includes('--pin')
const outFlag = argv.indexOf('--out')
const outPath = resolve(root, outFlag === -1 ? 'market/index.json' : argv[outFlag + 1])
const now = Math.floor(Date.now() / 1000)

if (wantCheck && wantPin) {
  console.error('--check 与 --pin 不能同时使用')
  process.exit(2)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const configPath = join(root, 'market', 'config.json')
const config = readJson(configPath)
const published = readJson(join(root, 'market', 'published.json'))
const problems = []
const warnings = []

const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()

/** 大致可靠的 SemVer 降序比较：先比数字三段，再让预发布版本低于正式版本。 */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = v.split('+')[0].split('-')
    return [core.split('.').map(Number), pre === '' ? null : pre.split('.')]
  }
  const [ac, ap] = split(a)
  const [bc, bp] = split(b)
  for (let i = 0; i < 3; i++) if (ac[i] !== bc[i]) return bc[i] - ac[i]
  if (ap === null && bp === null) return 0
  if (ap === null) return -1
  if (bp === null) return 1
  return bp.join('.').localeCompare(ap.join('.'))
}

/** 插件目录相对 market/ 解析（与配置里 "../packages/<name>" 的写法一致）；git 检查用绝对路径，git 自己会归一化。 */
function packageDir(plugin) {
  return resolve(root, 'market', plugin.dir)
}

function loadPackage(plugin) {
  const dir = packageDir(plugin)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    problems.push(`${plugin.dir}: 找不到 package.json`)
    return undefined
  }
  const manifest = readJson(manifestPath)
  if (manifest.dsh?.bundle === undefined) {
    problems.push(`${plugin.dir}: 没有声明 dsh.bundle，装进 profile 也不会成为组合包`)
  }
  return manifest
}

/** 把 git 来源里的 "HEAD" 换成真实 commit；--pin 时顺带写回配置。 */
function resolveSource(plugin, entry, manifest) {
  const source = entry.source ?? plugin.source ?? { type: 'npm', registry: config.defaults?.registry }
  if (source.type !== 'git') return source
  const pinned = { ...source, url: source.url.replace(/\.git$/, '') }
  if (typeof source.commit === 'string' && /^head$/i.test(source.commit)) {
    let head
    try {
      head = git(['rev-parse', 'HEAD'])
    } catch (error) {
      problems.push(`${manifest.name}: 无法解析 HEAD（${error.message.split('\n')[0]}）`)
      return pinned
    }
    const dirty = git(['status', '--porcelain', '--', packageDir(plugin)])
    if (dirty !== '') {
      warnings.push(`${manifest.name}: 插件目录有未提交改动，索引将指向不含这些改动的 ${head.slice(0, 8)}`)
    }
    if (wantPin) {
      source.commit = head
      pinned.commit = head
    } else {
      pinned.commit = head
    }
  }
  return pinned
}

function buildVersion(plugin, manifest, entry, index) {
  const version = entry.version ?? manifest.version
  if (typeof version !== 'string') {
    problems.push(`${plugin.dir}: 缺少版本`)
    return undefined
  }
  const key = `${manifest.name}@${version}`
  let publishTimestamp = entry.publishTimestamp ?? published[key]
  if (publishTimestamp === undefined) {
    if (wantCheck) {
      problems.push(`${key}: published.json 里没有发布时间`)
      return undefined
    }
    publishTimestamp = now
    warnings.push(`${key}: published.json 里没有发布时间，暂用当前时间`)
  }
  return {
    version,
    publishTimestamp,
    source: resolveSource(plugin, entry, manifest),
    engines: { dsh: entry.engines?.dsh ?? manifest.engines?.dsh ?? config.defaults?.dshRange },
  }
}

function buildPlugin(plugin) {
  const manifest = plugin.dir ? loadPackage(plugin) : undefined
  if (manifest === undefined) return undefined
  const declared = plugin.versions ?? [{}]
  const versions = declared.map((entry) => buildVersion(plugin, manifest, entry, config)).filter(Boolean)
  if (versions.length === 0) return undefined
  return {
    name: manifest.name,
    title: plugin.title ?? { en: manifest.description ?? manifest.name },
    ...(plugin.description === undefined ? {} : { description: plugin.description }),
    ...(plugin.icon === undefined ? {} : { icon: plugin.icon }),
    ...(plugin.author === undefined ? {} : { author: plugin.author }),
    ...(plugin.homepage === undefined ? {} : { homepage: plugin.homepage }),
    ...(plugin.repository === undefined ? {} : { repository: plugin.repository }),
    metadata: {
      ...(plugin.category === undefined ? {} : { category: plugin.category }),
      keywords: plugin.keywords ?? [],
      labels: plugin.labels ?? [],
      sortKeys: plugin.sortKeys ?? {},
    },
    versions: versions.sort((a, b) => compareVersions(a.version, b.version)),
  }
}

const index = {
  format: 1,
  title: config.index.title,
  ...(config.index.description === undefined ? {} : { description: config.index.description }),
  metadata: config.metadata ?? {},
  plugins: (config.plugins ?? []).map(buildPlugin).filter(Boolean),
}

const names = new Set()
for (const plugin of index.plugins) {
  if (names.has(plugin.name)) problems.push(`${plugin.name}: 索引内重复`)
  names.add(plugin.name)
}

// 最终把关：DSH 官方校验器。
let official = false
try {
  const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
  parseMarketIndex(index, config.index.url)
  official = true
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    warnings.push('未安装 @deepseek-ai/dsh-plugin-market-index，只做了内置结构检查；请先 npm install')
  } else {
    problems.push(`官方校验失败: ${error.path ?? ''} ${error.reason ?? error.message}`)
  }
}

if (problems.length > 0) {
  console.error(`索引不合法，共 ${problems.length} 处：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  for (const warning of warnings) console.warn(`warn: ${warning}`)
  process.exit(1)
}

for (const warning of warnings) console.warn(`warn: ${warning}`)

if (wantCheck) {
  if (!existsSync(outPath)) {
    console.error(`缺少 ${outPath}：先跑 npm run build`)
    process.exit(1)
  }
  const committed = JSON.stringify(readJson(outPath))
  const built = JSON.stringify(index)
  if (committed !== built) {
    console.error('market/index.json 与配置不一致：跑 npm run build 后提交（git 来源发版要先 --pin）')
    process.exit(1)
  }
  console.log(`OK: ${index.plugins.length} 个插件，索引与配置一致（官方校验${official ? '已执行' : '缺失'}）`)
} else {
  if (wantPin) writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n')
  console.log(
    `已写出 ${outPath}（${index.plugins.length} 个插件，官方校验${official ? '已执行' : '缺失'}${wantPin ? '，已固化 commit' : ''}）`,
  )
}
