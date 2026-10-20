# dsh-plugins

ZRZRING 的 DSH 插件，同时托管一个插件市场索引。

| 组合包 | 说明 |
|---|---|
| [`dsh-edit-continue`](packages/dsh-edit-continue) | 已发送的消息可编辑重发；停止、中断或截断的轮次多一个三角形「继续生成」 |
| [`dsh-command-files`](packages/dsh-command-files) | `~/.agents/commands/*.md` 变成斜杠命令，发送时才注入正文 |
| [`dsh-desktop-notifications`](packages/dsh-desktop-notifications) | 任务完成、失败或等待确认时弹 Windows 通知 |

## 安装

索引直链（插件 → 发现 → 添加）：

```
https://zrzring.github.io/dsh-plugins/market/index.json
```

备用索引（Pages 不可达时）：`https://fastly.jsdelivr.net/gh/ZRZRING/dsh-plugins@main/market/index.json`

直接给 spec 也可以，走 npm，不需要 git 权限：

```
@zrzring/dsh-edit-continue@0.0.1
```

## 结构

```
packages/<name>/         插件包，必须声明 dsh.bundle.patch
market/config.json       索引源：元数据、插件列表、版本来源
market/published.json    发布账本：包名@版本 → Unix 秒
market/index.json        生成物，就是市场
scripts/build-index.mjs  生成并校验索引
```

## 发版

```bash
cd packages/<name> && npm publish
npm run build
```

1. 改插件、把版本号写进该包 `package.json`，`npm publish`；
2. `market/published.json` 补一行 `@zrzring/<name>@<version>`；
3. `npm run build`，提交推送（CI 跑 `npm run check`）。

来源写成 git 时仍然可用：`source` 填 git 与 `commit: "HEAD"`，发版前 `npm run pin` 钉死 40 位 commit。

## License

MIT
