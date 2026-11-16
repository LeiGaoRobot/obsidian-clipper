# Chrome Web Store listing — PagePick for Obsidian

Paste each section into the matching field of the Chrome Web Store Developer Dashboard.

## Store listing

**Name** (from the manifest): PagePick for Obsidian

**Category**: Productivity → Tools

**Language**: English (add Chinese (Simplified) as a second listing language)

### Summary (max 132 characters)

EN:
> Clip, highlight, and read web pages into your Obsidian vault, with optional AI templates and transcript learning.

ZH:
> 把网页剪藏、高亮、阅读整理进你的 Obsidian 仓库，可选 AI 模板与视频字幕学习。

### Description

EN:

```
PagePick saves web pages to your Obsidian vault as clean Markdown files you own and can read offline.

PagePick is an independent, open-source community extension based on Obsidian Web Clipper. It is not made by or affiliated with Obsidian.

CLIP
• Save articles, recipes, videos, and any page as Markdown with properties
• Templates pick the note name, folder, and properties, and can apply automatically by URL
• Quick clip with a keyboard shortcut or the right-click menu

HIGHLIGHT
• Highlight text and page elements; highlights come back when you revisit the page
• Clip only your highlights, or the whole page with highlights marked

READ
• Reader mode strips clutter for focused reading, with adjustable typography and code highlighting
• Video pages (YouTube, Bilibili) show an interactive transcript

AI (OPTIONAL, BRING YOUR OWN KEY)
• Interpreter fills template prompts with an AI model: summaries, tags, key points
• AI edit rewrites the clipping or a selection, with a preview before applying
• Transcript learning: translation, Japanese readings, grammar analysis, and word explanations
• Works with OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, other OpenAI-compatible endpoints, and local command-line tools

PRIVACY
• No account, no servers, no analytics or tracking
• AI is off until you add a provider; requests run only when you start them and go directly to the provider you chose
• API keys stay on this device and are never synced

Some AI actions, such as translating a long transcript, send several requests and may create several charges on your provider account.

Open source: https://github.com/LeiGaoRobot/obsidian-clipper
```

ZH:

```
PagePick 把网页保存为干净的 Markdown 文件，存进你的 Obsidian 仓库，文件归你所有，可离线阅读。

PagePick 是基于 Obsidian Web Clipper 的独立开源社区扩展，并非由 Obsidian 制作，也与其无关联。

剪藏
• 把文章、菜谱、视频等任何网页保存为带属性的 Markdown
• 模板决定笔记名称、文件夹和属性，可按网址自动套用
• 支持快捷键和右键菜单快速剪藏

高亮
• 高亮文字和页面元素，再次打开页面时高亮自动恢复
• 可以只剪藏高亮内容，或剪藏整页并标出高亮

阅读
• 阅读模式去除干扰，可调排版，支持代码高亮
• 视频页面（YouTube、哔哩哔哩）显示可交互字幕

AI（可选，使用你自己的密钥）
• 解释器用 AI 填写模板中的提示词：摘要、标签、要点
• AI 编辑改写剪藏内容或选中部分，应用前可预览
• 字幕学习：翻译、日语注音、语法分析、单词解释
• 支持 OpenAI、Anthropic、Google Gemini、DeepSeek、OpenRouter 及其他 OpenAI 兼容接口，也支持本地命令行工具

隐私
• 无需注册，没有服务器，没有统计或跟踪
• 添加服务商之前 AI 不会启用；只有你主动发起时才会请求，并直接发往你选择的服务商
• API 密钥只保存在本设备，不会同步

部分 AI 操作（如翻译长字幕）会发出多次请求，可能在你的服务商账户上产生多笔费用。

开源地址：https://github.com/LeiGaoRobot/obsidian-clipper
```

### Assets to prepare

- Store icon: 128×128 PNG — use `src/brands/pagepick/icons/pagepick128.png`
- Screenshots: at least 1, up to 5, 1280×800 or 640×400. Suggested: popup with a template, highlights on a page, Reader mode, transcript translation, AI settings
- Small promo tile (optional): 440×280
- Do not use the Obsidian logo or the name "Obsidian Web Clipper" in images

## Privacy practices tab

### Single purpose

> Save web pages, highlights, and reading notes into the user's Obsidian vault as Markdown.

### Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Reads the page the user is on when they open the extension or use a shortcut, to build the clipping. |
| `clipboardWrite` | Hands the clipped note to the Obsidian app through the clipboard (Obsidian reads it from there, which avoids URL length limits), and copies Markdown when the user chooses Copy to clipboard. |
| `commands` | Provides keyboard shortcuts for opening the clipper, quick clip, highlighter, and Reader. |
| `contextMenus` | Adds right-click menu items to open the clipper, copy the page as Markdown, highlight a selection or element, and open the side panel. |
| `sidePanel` | Lets the user keep the clipper open in Chrome's side panel while browsing. |
| `storage` | Stores templates, settings, highlights, and the user's AI provider configuration. API keys are kept in local storage only. |
| `scripting` | Injects the extension's own bundled scripts into a page on demand, for clipping, highlighting, and Reader mode, so they do not load on every page. |
| `declarativeNetRequest` | Adds a session-only rule that sets the Referer header for embedded YouTube players in Reader mode, so videos play inside the Reader. |
| `nativeMessaging` | Optional. Connects to a helper app the user installs separately, so AI requests can run through command-line tools on the user's computer. Nothing is sent unless the user installs the helper and starts an AI action. |
| Host permission `<all_urls>` | The user can clip, highlight, and read any website. The extension needs to read the current page's content, restore saved highlights when the user returns to a page, fetch video transcripts, and send AI requests to the provider endpoint the user configured (which can be any host, including self-hosted ones). |

### Remote code

> No, I am not using remote code. All JavaScript is bundled in the extension package.

### Data usage

Check:

- **Website content** — page text, title, and URL are processed to create clippings; sent to the user's chosen AI provider only when the user starts an AI action.
- **Authentication information** — the user's own AI provider API keys, stored locally and sent only to that provider.

Leave the other data types unchecked.

Certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

https://github.com/LeiGaoRobot/obsidian-clipper/blob/main/store/chrome-web-store/PRIVACY.md

## Test instructions for reviewers

```
No account is needed. To test clipping without Obsidian installed, open any article, click the extension icon, and choose "Copy to clipboard" from the menu next to "Add to Obsidian".

AI features are optional and require the reviewer's own API key: Settings → AI → Add provider. The Native Messaging host is an optional separate install and is not needed to review the extension.
```
