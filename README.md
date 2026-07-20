PagePick for Obsidian is an independently published community fork for highlighting and capturing the web in your favorite browser. Anything you save is stored as durable Markdown files that you can read offline and preserve for the long term. It is not affiliated with or endorsed by Obsidian.

- **[PagePick source](https://github.com/LeiGaoRobot/obsidian-clipper)**
- **[Upstream documentation](https://help.obsidian.md/web-clipper)**
- **[Upstream troubleshooting](https://help.obsidian.md/web-clipper/troubleshoot)**

## Get started

PagePick for Obsidian is the independently branded Chrome build in this repository. Follow the [local-install instructions](#install-the-extension-locally) to load its `dist` directory until its separate Chrome Web Store listing is available. It is not the official Obsidian Web Clipper listing.

## Use the extension

The [upstream Obsidian Help site](https://help.obsidian.md/web-clipper) covers [highlighting](https://help.obsidian.md/web-clipper/highlight), [templates](https://help.obsidian.md/web-clipper/templates), [variables](https://help.obsidian.md/web-clipper/variables), [filters](https://help.obsidian.md/web-clipper/filters), and more. It may not describe PagePick-specific changes.

## Contribute

### Translations

You can help translate PagePick into your language. Submit your translation via pull request using the format found in the [/_locales](/src/_locales) folder.

### Features and bug fixes

See the [PagePick issues](https://github.com/LeiGaoRobot/obsidian-clipper/issues) for contributions and bug reports.

## Roadmap

In no particular order:

- [ ] Annotate highlights
- [ ] Template directory
- [ ] Sync settings across browsers
- [x] A separate icon for Web Clipper (1.6.3)
- [x] Template validation (1.1.0)
- [x] Template logic (if/for)  (1.1.0)
- [x] Save images locally ([Obsidian 1.8.0](https://obsidian.md/changelog/2024-12-18-desktop-v1.8.0/))
- [x] Translate UI into more languages — help is welcomed

## Developers

To build the extension:

```
npm run build
```

This will create three directories:
- `dist/` for the Chromium version
- `dist_firefox/` for the Firefox version
- `dist_safari/` for the Safari version

### Resolve template prompts with a local CLI

The Node CLI can resolve `{{"prompt"}}` template variables through a locally installed and authenticated AI CLI. Build it first:

```
npm run build:cli
```

Then choose a headless execution mode:

```
node dist/cli.cjs <url> --template <template.json> --execution-mode grok
node dist/cli.cjs <url> --template <template.json> --execution-mode codex
```

The `grok` mode runs Grok in single-turn mode. The `codex` mode runs Codex with an ephemeral, read-only sandbox. Both modes require the corresponding CLI to be available on `PATH` and already authenticated. Without `--execution-mode`, prompt variables keep their existing unresolved behavior.

### Use Grok or Codex from the Chrome extension

The Chrome extension can use the same local CLI modes through Native Messaging. Build and load the extension first, then copy its ID from `chrome://extensions` and install the host once:

```
npm run build:chrome
npm run install:native-host -- --extension-id <your-chrome-extension-id>
```

The installer records the detected `grok` and `codex` executable paths, so the host does not depend on Chrome's shell `PATH`. In Web Clipper **Settings → Interpreter**, enable Interpreter, choose **Grok CLI** or **Codex CLI** under **Execution mode**, then select **Check connection**. The check verifies the Native Messaging protocol and executable path without sending page content. The local CLI must already be installed and authenticated. The installer currently supports macOS and Linux.

Re-run the installer after changing the unpacked extension ID or rebuilding a source version that changes the Native Messaging protocol.

### Install the extension locally

For Chromium browsers, such as Chrome, Brave, Edge, and Arc:

1. Open your browser and navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist` directory

To enable the local Grok/Codex modes for this unpacked extension, run the Native Messaging host installer after loading it and use the extension ID shown on the extensions page. Reload the extension after installing the host.

For Firefox:

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to the `dist_firefox` directory and select the `manifest.json` file

If you want to run the extension permanently you can do so with the Nightly or Developer versions of Firefox.

1. Type `about:config` in the URL bar
2. In the Search box type `xpinstall.signatures.required`
3. Double-click the preference, or right-click and select "Toggle", to set it to `false`.
4. Go to `about:addons` > gear icon > **Install Add-on From File…**

For iOS Simulator testing on macOS:

1. Run `npm run build` to build the extension
2. Open `xcode/Obsidian Web Clipper/Obsidian Web Clipper.xcodeproj` in Xcode
3. Select the **Obsidian Web Clipper (iOS)** scheme from the scheme selector
4. Choose an iOS Simulator device and click **Run** to build and launch the app
5. Once the app is running on the simulator, open **Safari**
6. Navigate to a webpage and tap the **Extensions** button in Safari to access the Web Clipper extension

### Run tests

```
npm test
```

Or run in watch mode during development:

```
npm run test:watch
```

## Third-party libraries

- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for browser compatibility
- [defuddle](https://github.com/kepano/defuddle) for content extraction and Markdown conversion
- [dayjs](https://github.com/iamkun/dayjs) for date parsing and formatting
- [lz-string](https://github.com/pieroxy/lz-string) to compress templates to reduce storage space
- [lucide](https://github.com/lucide-icons/lucide) for icons
- [dompurify](https://github.com/cure53/DOMPurify) for sanitizing HTML

## License

The upstream Obsidian Web Clipper source code is open source under the MIT License. Upstream trademarks, icons, marketing copy, and other marketing assets are excluded from that license. PagePick for Obsidian uses its own icon and release copy.
