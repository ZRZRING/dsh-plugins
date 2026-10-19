# @local/dsh-command-files

把 `~/.agents/commands/` 里的 Markdown 文件变成可以主动调用的斜杠命令。

和 skills 的区别：

| | skills | 本插件 |
|---|---|---|
| 触发方式 | 模型按 description 被动加载，或 `/name` 主动用 | **只能**主动斜杠调用 |
| YAML header | 必需（name + description） | **不需要**，插件不解析 header |
| 加载内容 | 技能正文 + 资源提示 | **文件全文**（可选 `<command_content>` 包裹） |
| 模型目录 | 会出现在模型可见的 skill catalog | 从不进入模型上下文 |
| 结果 | 注入成 instructions 上下文 | 变成一条 user 消息（或当步注入） |

## 安装

在 profile 的 `package.json` 里加依赖，并把组合包加进 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "@local/dsh-command-files": "link:D:/path/to/dsh-plugins/packages/dsh-command-files"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@local/dsh-command-files"
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

- `/handoff` 回车：**只注入，不立刻发**。文件全文进入当前 inbox（`agent.inject`，不唤醒 driver），你可以在输入框继续补要求，按回车发出时两段内容一起带上——和 skills 的 `/name` 手势是同一个感觉。
- `/handoff 重点写测试部分`：这一行会作为普通 prompt 发出，插件在 `agent/pre-step` 里识别 `/handoff` token，把全文作为该步的注入指令追加进去。
- 想让它一执行就立刻开新一轮（不需要再打字），把 `immediate` 设为 `true`。
- `/` 菜单里能看到每个命令，描述取自文件第一行（`# 标题` 会去掉 `#`），所以第一行写成一句人能看懂的话最合适。

### 撤回

`/uninject`（名字由 `undoCommand` 配置）按状态做两件事：

| 状态 | 行为 | 结果 |
|---|---|---|
| 注入还在 inbox 里（还没发送） | `agent.inbox.remove(id)` | 直接消失，日志里只多一条 log-only 的 inbox splice，**不会产生 `user/message`** |
| 已经随消息发出（本轮已 claim） | 追加一条 surface `replace`，把那条 `user/message` 从模型可见面上 shadow 掉 | 后续请求不再包含它；原始记录仍在日志里（审计/可恢复）；对话记录里仍看得到原文 |

重复执行同名命令会先撤掉上一条挂起的注入再挂新的，不会叠两份。

第二种情况是“模型侧撤回”而不是“对话里删掉”：DSH 的 session log 是 append-only，`user/message` 一旦落地就无法物理删除；要连对话记录一起消失只能 fork 回退（在注入前的 seq 分叉一个新 session），本插件未实现。

### 文件写法

没有任何格式要求。建议：

```markdown
# 会话交接

给模型的完整指令……
```

- 第一行（或第一个标题）会作为 `/` 菜单里的描述。
- 可选的 YAML frontmatter 会被忽略（不会注入），但**不要求**写。
- 正文里的相对路径以文件所在目录为基准，注入时会告诉模型这个目录。

### 文件名规则

必须是 `[a-z][a-z0-9_-]*`（小写字母开头，可含数字、`-`、`_`）。空格和中文会被规范化或跳过，并在日志里记录原因。与内置命令（`/plan`、`/goal`、`/compact` 等）重名时，本插件会跳过该文件而不是让插件加载失败。

## 配置

优先级：`config.json` 的 `settings` > 组合包 patch 的 `config` > 内置默认值。`config.json` 每次扫描/调用都会重新读，改完即生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 注销所有命令 |
| `dirs` | `[]` | 额外命令目录，绝对路径或 `~` 开头 |
| `includeDefaults` | `true` | 是否扫描默认的 `~/.agents/commands` 与 `~/.agents/command` |
| `watch` | `true` | 监听目录变化并即时重注册 |
| `maxBytes` | `262144` | 单文件上限，超过则拒绝注入 |
| `descriptionMaxLength` | `120` | 菜单描述长度上限 |
| `wrap` | `true` | 是否用 `<command_content>` 包裹正文 |
| `immediate` | `false` | `false` 只入队（随下一条消息发出，期间可继续输入）；`true` 立即开新一轮 |
| `undoCommand` | `uninject` | 撤回命令名；留空不注册 |
| `locale` | `zh` | 命令结果提示语言 |
| `debugLog` | `true` | 写 `%TEMP%\dsh-command-files.log` |

## 行为细节

- **注入形态**：`wrap: true` 时模型收到

  ```text
  <command_content name="handoff">
  <command_resources>
  Base directory for this command: C:\Users\you\.agents\commands
  ...
  </command_resources>

  <command_instructions>
  （文件全文）
  </command_instructions>
  </command_content>
  ```

- **两条路径**：菜单/回车执行走命令 handler（默认 `agent.inject` 入队，随你下一条消息一起发出；`immediate: true` 时改用 `agent.followup` 立即开新一轮）；带参数的行走 pre-step 注入（落在同一轮最靠后的位置）。两条路径不会同时触发，因为命令执行时那一行根本不会变成 prompt。
- **热更新**：`fs.watch` 监听目录（目录不存在时监听最近的已存在祖先），150ms 防抖后重扫；`commands/change` 会让 Web 端的 `/` 目录缓存失效。
- **失败行为**：文件缺失、为空、超限或读取失败时，命令返回 error 结果，草稿和附件不会被吞掉。

## 已知限制

- 命令名必须是 ASCII 小写；中文文件名会被跳过（日志里有记录）。
- 只有顶层与子目录里的 `*.md`；其他扩展名不识别。
- 每个命令文件都用 `node:fs` 直接读，读到的是宿主视角的原文件；沙箱只影响模型工具，不影响这里。
- 与内置命令重名时静默跳过（日志中 `register-failed`）。
