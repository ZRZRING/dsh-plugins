# @zrzring/dsh-command-files

把 `~/.agents/commands/` 里的 Markdown 文件变成 `/` 菜单里可以直接点、也可以自己敲的斜杠命令。

命令走的是 **skills 的通道**（注册成 skill provider），所以输入体验和 skill 完全一致：

```
/handoff 帮我整理这次重构的交接文档
└──────┬──────────────────────────┘
   选中后只插入这段文字，可以继续补，也可以直接删掉
```

- **选中只插入文本**，不执行、不发送，光标停在 `/handoff ` 后面，接着打字就行。
- **发送时才注入**：正文在 `agent/pre-step` 里作为 `<skill_content>` 追加进这一步，和你这条消息一起到达模型。
- **删掉就是撤回**：把 `/handoff` 这几个字删掉再发，等于没这回事，对话记录里也不会留任何痕迹。
- **不会被动加载**：`modelInvocable: false`，它永远不出现在模型可见的 skill catalog 里，模型只在你亲手用了 `/name` 的那一步才看到正文。不需要写 YAML header。

## 和 skills 的关系

| | 普通 skill | 本插件 |
|---|---|---|
| 触发 | 模型按 description 主动加载，或 `/name` | **只能**由用户敲/点 `/name` |
| 出现在模型目录 | 会 | **从不**（`modelInvocable: false`） |
| YAML header | 需要 name/description | **不需要**，描述取文件第一行 |
| 注入时机 | 用户显式 `/name` 时 | 同一套（宿主 `dsh-tool-skill` 的 `/name` 手势） |
| 注入形态 | `<skill_content>` / `<skill_instructions>` | 完全相同 |
| 重名 | — | 真 skill 优先（本插件 rank 700，本地 skill 是 100–600） |

## 安装

在 profile 的 `package.json` 里加依赖，并把组合包加进 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "@zrzring/dsh-command-files": "link:D:/path/to/dsh-plugins/packages/dsh-command-files"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@zrzring/dsh-command-files"
      ]
    }
  }
}
```

然后在 profile 目录里 `pnpm install`。组合包自带的 `cordis.patch.yml` 会插入 `command-files` 这一行，不需要再改 profile patch。

## 使用

在 `~/.agents/commands/` 里放文件即可（也兼容单数 `~/.agents/command/`）：

```
~/.agents/commands/
  handoff.md      → /handoff
  review.md       → /review
  git/commit.md   → /git-commit   （子目录用 - 连接）
```

敲 `/` 打开菜单，它们在 skills 分组里，行尾标着「用户专属」——意思是只给用户用、不会进模型目录。选中后：

```text
/handoff █                    ← 光标停在这里，继续写你的要求
/handoff 重点写测试部分 █      ← 或者先写字再发
```

回车发送 → 模型收到你这条 user 消息（含 `/handoff` 字面量）+ 紧随其后的 `<skill_content name="handoff">`。这也意味着你可以手敲 `/handoff`，不点菜单也一样生效。

想反悔？直接删掉 `/handoff` 这几个字符。没有 `/uninject`，也不需要——没发送就什么都没发生。

### 文件写法

没有任何格式要求。建议：

```markdown
# 会话交接

给模型的完整指令……
```

- 第一行（或第一个标题）会作为 `/` 菜单里的描述。
- 可选的 YAML frontmatter 会被识别并跳过（不会注入），但**不要求**写。
- 正文里的相对路径以文件所在目录为基准，注入时会告诉模型这个目录（`<skill_resources>`）。

### 文件名规则

skill 名必须是 kebab-case（`[a-z0-9]+(-[a-z0-9]+)*`）：小写字母开头，只含小写字母、数字和 `-`。空格和下划线会被规范成 `-`，中文或其他字符会被跳过并在日志里记录原因。

## 配置

优先级：`config.json` 的 `settings` > 组合包 patch 的 `config` > 内置默认值。`config.json` 每次发现/加载都会重新读，改完即生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时 `/` 菜单里不再出现这些命令 |
| `dirs` | `[]` | 额外命令目录，绝对路径或 `~` 开头 |
| `includeDefaults` | `true` | 是否扫描默认的 `~/.agents/commands` 与 `~/.agents/command` |
| `watch` | `true` | 监听目录变化并让目录缓存失效 |
| `maxBytes` | `262144` | 单文件上限，超过则不加载 |
| `descriptionMaxLength` | `120` | 菜单描述长度上限 |
| `locale` | `zh` | 兜底描述文案语言 |
| `debugLog` | `true` | 写 `%TEMP%\dsh-command-files.log` |

## 行为细节

- **注入形态**（由宿主统一渲染，和 skill 一致）：

  ```text
  <skill_content name="handoff">
  <skill_resources>
  Base directory for this skill: C:\Users\you\.agents\commands
  Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
  </skill_resources>

  <skill_instructions>
  （文件全文，frontmatter 已剥离）
  </skill_instructions>
  </skill_content>
  ```

- **一次一条**：`/name` 手势按消息扫描、去重后注入一次；同一条消息里写两遍 `/handoff` 也只注入一份。
- **正文现读**：每次发送都重新读文件，改正文立刻生效，不用重启。
- **热更新**：`fs.watch` 监听目录（目录不存在时监听最近的已存在祖先），150ms 防抖后让 provider 目录失效。
- **失败行为**：文件缺失、为空、超限或读不出来时，provider 就不列它 / `get()` 返回 `undefined`，宿主把它当普通文本处理（不会伪造注入）。

## 已知限制

- 命令名必须是 ASCII kebab-case；中文文件名会被跳过（日志里有记录）。
- 只有 `*.md`；其他扩展名不识别。
- `/` 菜单的 skill 目录由 Web 客户端按会话缓存：**新加或改名**的文件可能要重开会话（或刷新页面）才出现在菜单里；**改正文**不受影响。
- 与真 skill 重名时真 skill 赢（rank 700 vs 100–600），本插件的同名文件这一条不生效（日志里会有 `duplicate-name` 记录）。
- 文件用 `node:fs` 直接读，读到的是宿主视角的原文件；沙箱只影响模型工具，不影响这里。
