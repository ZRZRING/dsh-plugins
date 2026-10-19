# dsh-plugins

ZRZRING 的 DeepSeek Harness 插件仓库，同时自托管一个 DSH 插件市场索引。

| 内容 | 说明 |
|---|---|
| 组合包 | [`packages/dsh-desktop-notifications`](packages/dsh-desktop-notifications) — 任务完成/失败/等待确认时弹 Windows 系统通知 |
| 组合包 | [`packages/dsh-command-files`](packages/dsh-command-files) — 把 `~/.agents/commands/*.md` 变成只主动调用的斜杠命令，调用时注入全文 |
| 组合包 | [`packages/dsh-edit-continue`](packages/dsh-edit-continue) — 已发送的消息可就地编辑并作为新分支重发；被停止/中断/截断的一轮多一个三角形「继续生成」按钮 |
| 市场索引 | [market/index.json](market/index.json) |
| 索引直链 | `https://zrzring.github.io/dsh-plugins/market/index.json` |

索引直链的备选（DSH 不接受重定向，以下都实测为 200 直连）：

| 地址 | 说明 |
|---|---|
| `https://zrzring.github.io/dsh-plugins/market/index.json` | **推荐**。GitHub Pages，`application/json`，改完推送约 1 分钟生效 |
| `https://fastly.jsdelivr.net/gh/ZRZRING/dsh-plugins@main/market/index.json` | jsDelivr CDN，国内直连通常可达；分支引用有最长 12 小时缓存，更新会滞后 |
| `https://raw.githubusercontent.com/ZRZRING/dsh-plugins/main/market/index.json` | 上游原文，内容最实时；但部分网络（含本机）直连会被重置，需要代理 |

## 装到 DSH

**从市场索引装**（推荐，先按 [DSH 插件市场说明](https://github.com/ZRZRING/dsh-plugins) 在插件页启用"自定义插件市场"）：
在**插件 → 发现**里添加上面的索引直链，然后安装列表里的组合包（`Desktop notifications`、`Edit and continue` 等）。

**直接按 spec 装**（索引里 `install` 字段给出的就是这一串，commit 以最新索引为准）：

```
git+https://github.com/ZRZRING/dsh-plugins.git#<commit>&path:/packages/dsh-desktop-notifications
```

把这一串交给 `plugin_manager` 的 `install_bundle` 即可；装上后由该组合包把 `desktop-notifications` 行插入 profile，
开关与通知文案在插件目录的 `config.json` 里改，每次触发重新读取，不用重装也不用重启。

## 目录结构

```
packages/<name>/     每个插件一个包，package.json 里必须有 dsh.bundle.patch
market/config.json   索引的唯一事实来源（元数据 + 插件列表 + git 来源）
market/published.json 发布账本：包名@版本 → Unix 秒
market/build-index.mjs 生成并校验 market/index.json
market/index.json    生成物，就是市场
```

## 维护

```bash
npm install                    # 需要官方校验器 @deepseek-ai/dsh-plugin-market-index
npm run build                  # 生成 market/index.json
npm run check                  # CI：校验 + 确认索引与配置一致
npm run pin                    # 发版时把 git 来源的 "commit": "HEAD" 固化成当前 HEAD
```

**发版三步**（索引里的 git 来源必须钉死 40 位 commit，所以顺序不能反）：

1. 改 `packages/<name>/`（版本号写进该包 `package.json`），并在 `market/published.json` 补一行 `包名@版本`；
2. `git commit` 这个改动 —— 这个 commit 里就是新代码；
3. `npm run pin && npm run build`，把 `market.config.json` 与 `market/index.json` 一起提交推送。

**加新插件**：在 `packages/` 下建包 → 在 `market/config.json` 的 `plugins` 里加一条（`dir`、分类、关键词、`source`）→ 走上面三步。
分类/标签/排序键必须先在该文件的 `metadata` 里声明，否则索引校验不通过。

## 说明与限制

- 索引**未签名**：里面的包名、版本、兼容范围都只是市场的声明，最终以装上的包清单为准。
- 兼容性按每个版本的 `engines.dsh` 与用户运行时版本比对；不满足时用户需要显式豁免才能装。
- DSH 目前**没有升级操作**：升级 = 卸载后重新安装。
- 索引由 GitHub Pages 直链提供；DSH 不接受重定向，Pages 与 jsDelivr 均为 200 直连。
- 索引读取有 10 分钟缓存（`cacheTtlMs`）；GitHub Pages 自身也有约 10 分钟边缘缓存，所以刚推送的改动大约一两分钟后才会出现在用户端。

## License

MIT
