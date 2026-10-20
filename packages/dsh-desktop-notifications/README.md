# Desktop Notifications（DSH 插件）

任务**完成**、**失败**或**等待你确认**时，弹一条系统通知（可单独开提示音）。

安装方式：`plugin_manager install_bundle` 指向本目录，已装进 `desktop` profile（bundle `@zrzring/dsh-desktop-notifications`）。

## 改文案 / 改开关 → 只改 `config.json`

`config.json` 在**每次触发时重新读取**，所以改完立刻生效：不用重装插件，也不用重启 DSH。

```json
{
  "settings": {
    "mode": "always",          // always = 每次都通知；off = 关掉插件
    "sound": "none",           // none 静音 | ding 系统 ding.wav | system 你的系统声音方案
    "soundFile": "",           // 指定任意 wav 路径（存在时优先于 sound）
    "aumid": "Microsoft.Windows.PowerShell",  // 通知上显示的应用名由它决定
    "onComplete": true,        // 任务完成
    "onFailure": true,         // 任务失败
    "onWaiting": true,         // 等待你确认（提问/审批）
    "locale": "zh",            // zh | en，决定用下面哪套文案
    "debugLog": true,          // 决策日志写到 %TEMP%\dsh-desktop-notifications.log
    "debugEvents": false,      // 额外记录收到的每个触发事件（排查用）
    "announceOnStart": false   // true = 插件激活时先弹一条，用于自测
  },
  "messages": {
    "zh": {
      "completeTitle": "DSH · 任务完成",
      "completeBody": "{subject} 已完成，等待你的下一步"
    }
  }
}
```

- **只写你要改的字段**：`messages.<locale>` 是逐键覆盖，没写的继续用内置文案。
- **占位符**：`{subject}` = 项目/会话名，`{detail}` = 提问内容、审批原因或报错信息。
- 必须是**严格 JSON**：不能有注释、不能有多余逗号。
- 想更安静：`"mode": "off"`；只想关声音：`"sound": "none"`。

## 日志

`%TEMP%\dsh-desktop-notifications.log`（即 `C:\Users\<你>\AppData\Local\Temp\dsh-desktop-notifications.log`）

每行一次决策，例如：

```
ready build=1.0.6 mode=always sound=none locale=zh ...
show kind=waiting session=<id> title="DSH · 等待你的确认" body="..."
delivered title="..." sound=off toast=shown
skip kind=complete session=<id> reason=duplicate
```

`toast=shown` 表示已交给系统投递；`toast=unavailable` 表示 WinRT 通知给不出来（例如专注助手/系统策略拦截）。

## 触发范围

- 只针对**主会话**：subagent 子会话的 running/idle 一律不发通知。
- 同一会话同一类型 3 秒内去重；同一会话的报错 10 秒内只通知一次。
- 审批通知只在审批策略为 `ask` 时可能出现（`never` 策略下审批不会请求你，直接拒绝）。

## 已知限制

- 通知归属显示为 **Windows PowerShell**：WinRT toast 需要一个已注册的 AUMID，而这个进程没有自己的。想换成别的名字，把 `aumid` 改成任意已注册过快捷方式的 AUMID。
- 点击通知**不会**帮你把 DSH 窗口切到前台：无 AUMID 激活句柄时 WinRT toast 点击无动作。
- DSH 的 host 跑在普通 Node 子进程里（拿不到 Electron API），所以通知走的是操作系统通道，而不是 Electron 原生通知。
