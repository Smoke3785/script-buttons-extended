![banner](images/banner.png)

# Script Buttons Extended for VSCode

Make running custom scripts easier!

> **Maintained fork.** This is a maintained fork of [jwaterfall/script-buttons](https://github.com/jwaterfall/script-buttons), which as far as I can tell is no longer being updated. New features and fixes ship here.

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

| Setting                         | Type                                  | Default       | Description                                                                                                                                                                          |
| ------------------------------- | ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scriptButtons.sources`         | `"package"` \| `"config"` \| `"both"` | `"both"`      | Which sources to pull scripts from.                                                                                                                                                  |
| `scriptButtons.filter.mode`     | `"whitelist"` \| `"blacklist"`        | `"blacklist"` | How the filter list is applied to `package.json` scripts.                                                                                                                            |
| `scriptButtons.filter.contents` | `string[]`                            | `[]`          | Script names to include or exclude (per `mode`). Only affects `package.json` scripts.                                                                                                |
| `scriptButtons.scripts`         | `{ label, script }[]`                 | `[]`          | Custom buttons. `label` is the button text; `script` is either a shell command string **or** an array of step objects forming a DAG (see [Multi-step buttons](#multi-step-buttons)). |
| `scriptButtons.showNpmInstall`  | `boolean`                             | `true`        | Show the special **NPM Install** button when a `package.json` is detected.                                                                                                           |

### Example: VSCode settings

```jsonc
// .vscode/settings.json
{
  "scriptButtons.sources": "both",
  "scriptButtons.filter": {
    "mode": "blacklist",
    "contents": ["prepublish", "postinstall"],
  },
  "scriptButtons.scripts": [
    { "label": "Dev Server", "script": "npm run dev" },
    { "label": "Reset DB", "script": "./scripts/reset-db.sh" },
  ],
  "scriptButtons.showNpmInstall": false,
}
```

### Example: `script-buttons.json` (new shape)

```jsonc
// script-buttons.json (or .vscode/script-buttons.json)
{
  "sources": "config",
  "scripts": [
    { "label": "Dev Server", "script": "npm run dev" },
    { "label": "Lint", "script": "npm run lint" },
  ],
}
```

### Backward compatibility

The original flat-dict shape for `script-buttons.json` is still supported — no migration required:

```jsonc
{
  "Dev Server": "npm run dev",
  "Lint": "npm run lint",
}
```

The shape is auto-detected: if any of `sources`, `filter`, `scripts`, or `showNpmInstall` keys are present, the file is read as a config object; otherwise it is treated as a legacy `name → command` dict.

## JSON Schema

The extension ships a JSON Schema for `script-buttons.json` and registers it via `contributes.jsonValidation`, so VSCode applies autocomplete and validation to any `script-buttons.json` (workspace root or `.vscode/`) automatically — no `$schema` field required.

If you want validation in editors other than VSCode, the schema is also published at:

```
https://raw.githubusercontent.com/Smoke3785/script-buttons-extended/main/schemas/script-buttons.schema.json
```

You can reference it from your file with a `$schema` key:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Smoke3785/script-buttons-extended/main/schemas/script-buttons.schema.json",
  "scripts": [{ "label": "Dev Server", "script": "npm run dev" }],
}
```

## Multi-step buttons

A button's `script` can be an array of **steps** instead of a single shell command. Each step is either a `shell` command or a `vscode` command (anything you can run from the command palette), and steps can declare dependencies on other steps via `reliesOn`. Steps with no `reliesOn` run **concurrently**; a step waits until all of its dependencies have finished successfully.

### Step fields

| Field      | Type                    | Required                         | Description                                                                                                   |
| ---------- | ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`       | `string`                | only if referenced by `reliesOn` | Unique identifier within this script.                                                                         |
| `type`     | `"shell"` \| `"vscode"` | yes                              | `shell` runs `command` in a task terminal; `vscode` calls `vscode.commands.executeCommand(command, ...args)`. |
| `command`  | `string`                | yes                              | Shell command line, or a VSCode command id (e.g. `workbench.action.files.saveAll`).                           |
| `args`     | `unknown[]`             | no                               | Arguments spread into `executeCommand`. Ignored for `shell` steps.                                            |
| `reliesOn` | `string` \| `string[]`  | no                               | Step id(s) that must complete successfully before this step runs.                                             |

### Example: build → test, with a save-all in parallel

```jsonc
{
  "scriptButtons.scripts": [
    {
      "label": "Build & Test",
      "script": [
        { "id": "clean", "type": "shell", "command": "rm -rf dist" },
        { "id": "build", "type": "shell", "command": "npm run build", "reliesOn": "clean" },
        { "id": "test", "type": "shell", "command": "npm test", "reliesOn": ["build"] },
        { "type": "vscode", "command": "workbench.action.files.saveAll" },
      ],
    },
  ],
}
```

In this example `clean` and the `saveAll` vscode command kick off immediately and in parallel; `build` starts when `clean` finishes; `test` starts when `build` finishes.

### Execution semantics

- **Shell steps** run as VSCode tasks (`vscode.tasks.executeTask` with a `ShellExecution`), so each step gets its own task terminal and a real exit code. A non-zero exit is treated as a failure.
- **VSCode steps** succeed if `executeCommand` resolves and fail if it throws.
- **Failure cascades.** If a step fails, every step that transitively depends on it is **skipped**. Independent branches keep running.
- **Output channel.** Orchestration logs (which step is running, success/failure/skip, and a final summary) are written to the **Script Buttons** output channel. If anything failed or was skipped, a warning toast offers a "Show Output" button.
- **Validation at registration.** Cycles, unknown `reliesOn` ids, duplicate `id`s, and missing `type`/`command` are detected when the button is registered. Invalid entries are skipped (logged to the output channel) without affecting other buttons.

The legacy single-string form is unchanged:

```jsonc
{ "label": "Dev", "script": "npm run dev" }
```

It still runs in a regular terminal with the original "dispose-and-recreate" behavior on repeated clicks.

## Known Issues

There are currently no known issues.

## Release Notes

### 1.3.0

- Buttons can now run **multiple steps** with dependencies. The `script` field on a custom button accepts an array of `{ id?, type, command, args?, reliesOn? }` steps. `type: "shell"` runs a shell command as a VSCode task; `type: "vscode"` calls `vscode.commands.executeCommand`. Steps with no `reliesOn` run concurrently; failures skip transitive dependents.
- New **Script Buttons** output channel logs orchestration events and shows a final summary per click.
- Added validation at registration time: cycles, unknown `reliesOn` ids, duplicate `id`s, and missing fields cause the button to be skipped (logged) instead of crashing init.
- Published a JSON Schema for `script-buttons.json` and registered it via `contributes.jsonValidation`, so editors get autocomplete and validation automatically.
- Legacy single-string scripts are unchanged.

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
