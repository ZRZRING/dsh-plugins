# dsh-edit-continue

给 DeepSeek Harness Web GUI 补上两件对话操作：

1. **编辑并重发** — 每条已发送的用户消息（`user` 行）在复制按钮旁多一个铅笔按钮。
   点开后消息就地变成文本编辑器；发送时不会改写原会话，而是**在该轮开始前切出一个新分支**，
   把编辑后的文本作为新分支的第一条消息发出，并自动切换过去。原会话和已经产生的输出都保留。
2. **继续生成** — 当最后一轮以「用户停止」「输出被截断（max tokens）」「进程中断恢复」结束时，
   输入框发送键左侧出现一个三角形按钮；点它就用同一套 `session.prompt` 发一条继续指令，
   让模型从断点接着写，不覆盖草稿。

## 行为细节

| 操作 | 说明 |
|---|---|
| 编辑第 N 轮（N>1） | 从第 N-1 轮的 `turn/end` 处切出新分支。**不能**切在 `turn/start` 前一个事件：用户消息先被 splice 进 turn-claim inbox，再写 `turn/start`，切在那里会把原消息一起带进分支并重放。 |
| 编辑第 1 轮 | 没有更早边界，改为在同一工作区新建会话后发送（语义等价：不带原消息重新开始）。 |
| 附件 | 编辑只重发文本；带附件的消息会在编辑器里提示「附件不会随编辑重发」。 |
| 不可编辑 | 本轮运行中、子会话消息、消息所在轮次的开头不在已加载历史窗口、正文为空、或找不到上一轮 `turn/end` 时，按钮置灰并在 tooltip 说明原因。 |
| 继续条件 | 最新一轮已关闭且原因为 `aborted` / `max-tokens` / `interrupted`，且当前空闲、不是子会话。 |
| 继续消息 | 发送的是一条**合成提示**（内容随界面语言：`继续（从上次中断的地方接着输出…）` / `Continue from where you left off…`）。它必须真实进入会话日志，模型才能据此续写，所以消息列表里仍然存在；但客户端渲染时按整句精确匹配把它隐藏，界面看上去就是模型直接接着往下写。副作用：手动发送完全相同的句子也会被隐藏。 |

## 安装

```bash
# 在 dsh 里（或让 agent 调 plugin_manager）：
# install_bundle target = <本目录绝对路径>
```

本地开发时把本目录链接进 profile 的 `node_modules`，并加入 `dsh.profile.bundles` 即可；
profile 运行着 HMR 时会自动重算组合，没开 HMR 则需要重启 DSH。

## 实现

- `index.js`：空 Host 插件，只让 Loader 行携带 `dsh.client` 声明。
- `client.js`：`window.__ModuleLoader__.load` 工厂，注册两个 Slot：
  - `conversation.chat.node` 的 `user` key（优先级 `-1` 覆盖内置渲染器），复用内置
    `conversation.chat.user.content` Factory 渲染正文，只额外加复制 / 编辑动作。
  - `conversation.input.right` 的列表项，渲染三角形「继续」按钮。
- 样式全部走 `--dsw-*` 主题 token，文本走 `ctx.locale` 字典（zh/en）。
- 不导入任何 Harness Client 运行时包，只依赖模块表里的 `react`。
