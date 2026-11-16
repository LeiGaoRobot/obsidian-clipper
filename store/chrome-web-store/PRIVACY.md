# PagePick for Obsidian — Privacy Policy

Last updated: 2026-11-16

PagePick for Obsidian ("the extension") is an independent, open-source community extension based on Obsidian Web Clipper (MIT License). It is not made by or affiliated with Obsidian (Dynalist Inc.).

## Summary

- The extension has no servers of its own. The developer does not collect, receive, sell, or share your data.
- There is no analytics, telemetry, advertising, or tracking.
- Your content leaves your browser only when you use a feature that sends it somewhere you chose: your Obsidian vault, your clipboard, or an AI provider that you configured with your own API key.

## Data the extension handles

| Data | When | Where it goes |
| --- | --- | --- |
| Content of the current web page (text, title, URL, metadata, selection) | When you open the extension, clip, highlight, or use Reader | Processed locally in your browser |
| Clipped notes | When you click Clip | Sent to the Obsidian app on your device (through the `obsidian://` link) or copied to your clipboard |
| Templates and settings | When you change them | Stored with Chrome storage. Settings marked for sync use Chrome Sync, which Google stores under your Google account |
| Highlights | When you highlight a page | Stored locally in your browser (`chrome.storage.local`) |
| AI provider API keys | When you enter them in Settings | Stored only on this device (`chrome.storage.local`). They are never synced and never sent anywhere except to the provider they belong to |
| Page content and your prompts for AI features | Only when you start an AI action (Interpreter, AI edit, translation, readings, grammar, explanation, or a connection Test) | Sent directly from your browser to the AI provider you configured (for example OpenAI, Anthropic, Google, DeepSeek, OpenRouter, or a self-hosted endpoint), or to a command-line tool on your computer through the optional Native Messaging host |
| AI diagnostics | When AI requests run | Kept in session storage, cleared when the browser closes. Entries hold only status, timing, and error type — never prompts, page content, keys, or provider responses |
| Video transcripts | When you open Reader on a supported video page (for example YouTube or Bilibili) | Fetched from that site to show the transcript |

## AI providers

AI features are off until you add a provider and your own credentials. No AI request runs automatically on page load. When you start one, the content you chose is sent to that provider and is handled under the provider's own privacy policy and terms. Some actions (such as translating a long transcript) send several requests and may create several billable charges on your provider account.

If you use the optional Native Messaging host with a local command-line tool (such as Codex CLI or Grok CLI), the extension passes the request to that tool on your computer. What the tool does next is governed by that tool and its provider.

## Permissions

The extension requests access to all websites so that it can read and clip the page you are on, show your highlights when you return to a page, and run Reader. It does not read pages in the background for any other purpose. See the store listing for a description of each permission.

## Your control

- You can remove your API keys, templates, highlights, and settings at any time in the extension's Settings, or by removing the extension.
- Turning off AI in Settings stops all AI requests.

## Children

The extension is not directed at children under 13 and does not knowingly collect information from them.

## Changes

Changes to this policy are published in this file in the project repository, with a new "Last updated" date.

## Contact

Open an issue at https://github.com/LeiGaoRobot/obsidian-clipper/issues

---

# PagePick for Obsidian 隐私政策

最后更新：2026-11-16

PagePick for Obsidian（以下称"本扩展"）是一个独立的开源社区扩展，基于 Obsidian Web Clipper（MIT 许可证）开发。本扩展并非由 Obsidian（Dynalist Inc.）制作，也与其无关联。

## 摘要

- 本扩展没有自己的服务器。开发者不收集、不接收、不出售、不分享你的数据。
- 没有任何统计分析、遥测、广告或跟踪。
- 只有当你使用某项功能、把内容发到你自己选定的地方时，内容才会离开浏览器：你的 Obsidian 仓库、剪贴板，或你用自己的 API 密钥配置的 AI 服务商。

## 本扩展处理的数据

| 数据 | 何时 | 去向 |
| --- | --- | --- |
| 当前网页内容（正文、标题、网址、元数据、选中文本） | 打开扩展、剪藏、高亮或使用阅读器时 | 在你的浏览器内本地处理 |
| 剪藏的笔记 | 点击剪藏时 | 通过 `obsidian://` 链接发送到你设备上的 Obsidian，或复制到剪贴板 |
| 模板和设置 | 修改时 | 保存在 Chrome 存储中；需要同步的设置走 Chrome 同步，由 Google 保存在你的 Google 账号下 |
| 高亮 | 高亮网页时 | 仅保存在本地浏览器（`chrome.storage.local`） |
| AI 服务商 API 密钥 | 在设置里填写时 | 仅保存在本设备（`chrome.storage.local`），不会同步，除了对应的服务商不会发送到任何地方 |
| 用于 AI 功能的网页内容和提示词 | 仅当你主动发起 AI 操作时（解释器、AI 编辑、翻译、注音、语法分析、解释或连接测试） | 由你的浏览器直接发送到你配置的 AI 服务商（如 OpenAI、Anthropic、Google、DeepSeek、OpenRouter 或自建服务），或通过可选的 Native Messaging 主机发给你电脑上的命令行工具 |
| AI 诊断记录 | AI 请求运行时 | 保存在会话存储中，关闭浏览器即清除；只记录状态、耗时和错误类型，绝不包含提示词、网页内容、密钥或服务商的回复 |
| 视频字幕 | 在支持的视频页面（如 YouTube、哔哩哔哩）打开阅读器时 | 从该网站获取，用于显示字幕 |

## AI 服务商

在你添加服务商并填写自己的凭据之前，AI 功能不会启用。页面加载时不会自动发起任何 AI 请求。你发起请求后，所选内容会发送给该服务商，并受该服务商自己的隐私政策和条款约束。部分操作（如翻译一份长字幕）会发出多次请求，可能在你的服务商账户上产生多笔费用。

如果你通过可选的 Native Messaging 主机使用本地命令行工具（如 Codex CLI、Grok CLI），本扩展会把请求交给你电脑上的该工具，之后的处理受该工具及其服务商约束。

## 权限

本扩展申请访问所有网站的权限，用于读取和剪藏你正在浏览的页面、在你重新访问时显示高亮，以及运行阅读器。本扩展不会出于其他目的在后台读取网页。各项权限的说明见商店页面。

## 你的控制权

- 你可以随时在扩展设置中删除 API 密钥、模板、高亮和设置，或直接卸载扩展。
- 在设置中关闭 AI 会停止所有 AI 请求。

## 儿童

本扩展不面向 13 岁以下儿童，也不会有意收集其信息。

## 变更

本政策的变更会发布在项目仓库的此文件中，并更新"最后更新"日期。

## 联系方式

请在 https://github.com/LeiGaoRobot/obsidian-clipper/issues 提交 issue。
