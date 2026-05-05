![banner](images/banner.png)

# Script Buttons Extended for VSCode

Make running custom scripts easier!

> **Maintained fork.** This is a community-maintained fork of [jwaterfall/script-buttons](https://github.com/jwaterfall/script-buttons), which is no longer being updated. New features and fixes ship here.

## Features

When a package.json file is detected in the current workspace folder a button is created on the status bar for each script. When this button is clicked it runs the script in a terminal. Only 1 instance of each script can run at a given time.

![scripts](images/scripts.png)

Scripts can also be loaded in from a script-buttons.json file (placed at the workspace root or inside the .vscode folder). Npm scripts will be white whereas non-npm scripts will be grey.

![scripts](images/script-buttons.json.png)

When no scripts can be found a warning message will be displayed.

![no-scripts](images/no-scripts.png)

> Tip: If you have since added a package.json/script-buttons.json file or have modified existing scripts clicking the refresh button will attempt to find scripts again and update the buttons. Buttons also refresh automatically when you change a `scriptButtons.*` setting.

## Configuration

Script Buttons can be configured from two places:

1. **VSCode settings** (`scriptButtons.*` keys in user or workspace `settings.json`) — defines defaults that apply across projects.
2. **A `script-buttons.json` file** at the workspace root or inside `.vscode/` — overrides settings on a per-project basis.

When both are present, the project file wins per-field. The `scripts` arrays from both sources are concatenated; if two entries share the same `label`, the project file entry is used.

### Available settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `scriptButtons.sources` | `"package"` \| `"config"` \| `"both"` | `"both"` | Which sources to pull scripts from. |
| `scriptButtons.filter.mode` | `"whitelist"` \| `"blacklist"` | `"blacklist"` | How the filter list is applied to `package.json` scripts. |
| `scriptButtons.filter.contents` | `string[]` | `[]` | Script names to include or exclude (per `mode`). Only affects `package.json` scripts. |
| `scriptButtons.scripts` | `{ label, script }[]` | `[]` | Custom buttons. `label` is the button text; `script` is the shell command. |
| `scriptButtons.showNpmInstall` | `boolean` | `true` | Show the special **NPM Install** button when a `package.json` is detected. |

### Example: VSCode settings

```jsonc
// .vscode/settings.json
{
  "scriptButtons.sources": "both",
  "scriptButtons.filter": {
    "mode": "blacklist",
    "contents": ["prepublish", "postinstall"]
  },
  "scriptButtons.scripts": [
    { "label": "Dev Server", "script": "npm run dev" },
    { "label": "Reset DB", "script": "./scripts/reset-db.sh" }
  ],
  "scriptButtons.showNpmInstall": false
}
```

### Example: `script-buttons.json` (new shape)

```jsonc
// script-buttons.json (or .vscode/script-buttons.json)
{
  "sources": "config",
  "scripts": [
    { "label": "Dev Server", "script": "npm run dev" },
    { "label": "Lint", "script": "npm run lint" }
  ]
}
```

### Backward compatibility

The original flat-dict shape for `script-buttons.json` is still supported — no migration required:

```jsonc
{
  "Dev Server": "npm run dev",
  "Lint": "npm run lint"
}
```

The shape is auto-detected: if any of `sources`, `filter`, `scripts`, or `showNpmInstall` keys are present, the file is read as a config object; otherwise it is treated as a legacy `name → command` dict.

## Known Issues

There are currently no known issues.

## Release Notes

### 1.2.0

- Forked and resumed maintenance.
- Added VSCode settings (`scriptButtons.*`) for `sources`, `filter`, custom `scripts`, and `showNpmInstall`.
- `script-buttons.json` now supports a richer object shape (`sources`, `filter`, `scripts`, `showNpmInstall`) in addition to the legacy flat-dict form.
- Buttons refresh automatically when `scriptButtons.*` settings change.
- The `NPM Install` button can now be hidden via `scriptButtons.showNpmInstall: false`.

### 1.1.1

Added an NPM install button if a package.json file is detected.

### 1.1.0

Added the ability to define scripts without a package.json file, this is done using a script-buttons.json file.

### 1.0.0

Initial release.
