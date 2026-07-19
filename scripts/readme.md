## Scripts

### Localization

First, add an OpenAI API key in `.env` at the root of the repo:

```
OPENAI_API_KEY=sk-...
```

Scripts can be run using npm in the root of the repo.

#### Update locale

```
npm run update-locales
```

- Checks the English locale file and automatically translates missing strings
- Reorganizes strings alphabetically

#### Add locale

```bash
npm run add-locale fr
```

### Version bump

```bash
./scripts/bump-version.sh 1.0.1
```

- Updates `version` in `package.json` and all source browser manifests
- Updates the two root package versions in `package-lock.json`
- Updates `MARKETING_VERSION` in the Xcode project
- Increments `CURRENT_PROJECT_VERSION` by 1

### Changelog

```bash
./scripts/generate-changelog.sh
```

- Generates `changelogs/<version>.md` from commits since the last git tag
- Reads the version from `package.json`
- Commits starting with `feat` are grouped under **New**
- Commits starting with `fix` are grouped under **Fixes**
- Version bump and documentation commits are excluded

### Native Messaging Host package

```bash
npm run package:native-host
```

- Generates `builds/obsidian-web-clipper-<version>-native-host.zip`
- Includes the macOS/Linux installer, Native Messaging Host, license, and standalone install instructions
- Does not include provider credentials or CLI authentication data

### Firefox reviewer build

The Firefox package is produced with Webpack and therefore needs a matching source archive for AMO review. Use Node.js 20.19 or newer and npm 11, then run:

```bash
npm ci
npm run build:firefox
```

The submission package is `builds/obsidian-web-clipper-<version>-firefox.zip`. The generated extension directory is `dist_firefox/`.
