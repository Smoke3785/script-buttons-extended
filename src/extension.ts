import { promises as fsPromises } from 'fs';
import { workspace } from 'vscode';
import vscode from 'vscode';

import type {
  ScriptButtonsConfig,
  ScriptButtonsFilter,
  ScriptSource,
  ScriptEntry,
  PackageJson,
  Disposable,
  Scripts,
} from './types';

const { readFile } = fsPromises;

const CONFIG_NAMESPACE = 'scriptButtons';

export function activate(context: vscode.ExtensionContext) {
  const disposables: Disposable[] = [];

  const terminals: { [name: string]: vscode.Terminal } = {};
  const cwd = getWorkspaceFolderPath();

  function addDisposable(disposable: Disposable) {
    context.subscriptions.push(disposable);
    disposables.push(disposable);
  }

  function cleanup() {
    while (disposables.length) {
      const disposable = disposables.pop();
      disposable?.dispose();
    }
  }

  function createStatusBarItem(text: string, tooltip?: string, command?: string, color?: string) {
    const item = vscode.window.createStatusBarItem(1, 0);

    item.command = command;
    item.tooltip = tooltip;
    item.color = color;
    item.text = text;

    addDisposable(item);
    item.show();

    return item;
  }

  function getWorkspaceFolderPath() {
    const workspaceFolder = workspace.workspaceFolders?.[0];
    const path = workspaceFolder?.uri.fsPath;

    return path;
  }

  async function getJsonFile<T>(path: string) {
    const fileBuffer = await readFile(path);
    const data = JSON.parse(fileBuffer.toString()) as T;

    return data;
  }

  async function getPackageJson() {
    return await getJsonFile<PackageJson>(`${cwd}/package.json`);
  }

  async function getScriptButtonsFile(): Promise<ScriptButtonsConfig | null> {
    const candidates = [`${cwd}/script-buttons.json`, `${cwd}/.vscode/script-buttons.json`];

    for (const path of candidates) {
      try {
        const raw = await getJsonFile<unknown>(path);
        return normalizeFileShape(raw);
      } catch {}
    }
    return null;
  }

  function normalizeFileShape(raw: unknown): ScriptButtonsConfig {
    if (!raw || typeof raw !== 'object') return {};
    const obj = raw as Record<string, unknown>;

    const newShapeKeys = ['sources', 'filter', 'scripts', 'showNpmInstall'];
    if (newShapeKeys.some((k) => k in obj)) {
      return obj as ScriptButtonsConfig;
    }

    // Legacy flat dict: { name: command, ... } — wrap as scripts list
    const scripts: ScriptEntry[] = Object.entries(obj)
      .filter(([, v]) => {
        return typeof v === 'string';
      })
      .map(([label, script]) => {
        return { label, script: script as string };
      });

    return { scripts };
  }

  function readSettingsConfig(): ScriptButtonsConfig {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return {
      showNpmInstall: cfg.get<boolean>('showNpmInstall'),
      scripts: cfg.get<ScriptEntry[]>('scripts') ?? [],
      sources: cfg.get<ScriptSource>('sources'),
      filter: {
        mode: cfg.get<ScriptButtonsFilter['mode']>('filter.mode') ?? 'blacklist',
        contents: cfg.get<string[]>('filter.contents') ?? [],
      },
    };
  }

  function mergeConfigs(
    base: ScriptButtonsConfig,
    override: ScriptButtonsConfig,
  ): ScriptButtonsConfig {
    const overrideLabels = new Set((override.scripts ?? []).map((s) => s.label));
    const baseFiltered = (base.scripts ?? []).filter((s) => {
      return !overrideLabels.has(s.label);
    });

    return {
      showNpmInstall: override.showNpmInstall ?? base.showNpmInstall,
      scripts: [...baseFiltered, ...(override.scripts ?? [])],
      sources: override.sources ?? base.sources,
      filter: override.filter ?? base.filter,
    };
  }

  async function loadConfig(): Promise<Required<ScriptButtonsConfig>> {
    const file = (await getScriptButtonsFile()) ?? {};
    const settings = readSettingsConfig();

    const merged = mergeConfigs(settings, file);

    return {
      filter: merged.filter ?? { mode: 'blacklist', contents: [] },
      showNpmInstall: merged.showNpmInstall ?? true,
      sources: merged.sources ?? 'both',
      scripts: merged.scripts ?? [],
    };
  }

  function applyFilter(scripts: Scripts, filter?: ScriptButtonsFilter): Scripts {
    if (!filter || !filter.contents?.length) {
      return scripts;
    }

    const set = new Set(filter.contents);
    const result: Scripts = {};

    for (const name in scripts) {
      const present = set.has(name);
      const keep = filter.mode === 'whitelist' ? present : !present;

      if (keep) {
        result[name] = scripts[name];
      }
    }

    return result;
  }

  function createErrorMessage() {
    createStatusBarItem(`$(circle-slash) Script Buttons`, `No scripts found!`, undefined);
  }

  function createRefreshButton() {
    createStatusBarItem(
      '$(refresh)',
      'Script Buttons: Refetches the scripts from your package.json file',
      'script-buttons.refreshScripts',
    );
  }

  function createButton(label: string, command: string, isNpm: boolean) {
    const vscCommand = createVscCommand(command, label, isNpm);
    const color = isNpm ? 'white' : undefined;

    createStatusBarItem(label, command, vscCommand, color);
  }

  function createVscCommand(command: string, name: string, isNpm = false) {
    const prefix = isNpm ? 'npm-' : 'custom-';
    const vscCommand = `script-buttons.${prefix}${name.replace(/\s+/g, '_')}`;

    const commandDisposable = vscode.commands.registerCommand(vscCommand, async () => {
      let terminal = terminals[vscCommand];

      if (terminal) {
        delete terminals[vscCommand];
        terminal.dispose();
      }

      terminal = vscode.window.createTerminal({
        name,
        cwd,
      });

      terminals[vscCommand] = terminal;

      terminal.show(true);
      terminal.sendText(command);
    });

    addDisposable(commandDisposable);
    return vscCommand;
  }

  async function init() {
    cleanup();
    registerCommands();
    createRefreshButton();

    const config = await loadConfig();
    let buttonCount = 0;

    if (config.sources !== 'config') {
      try {
        const packageJson = await getPackageJson();
        console.log('Loaded package.json!');

        if (config.showNpmInstall) {
          createButton('NPM Install', 'npm install', true);
          buttonCount++;
        }

        const filtered = applyFilter(packageJson.scripts ?? {}, config.filter);
        for (const name in filtered) {
          createButton(name, `npm run ${name}`, true);
          buttonCount++;
        }
      } catch {
        console.log('No package.json found!');
      }
    }

    if (config.sources !== 'package') {
      const seenLabels = new Set<string>();
      for (const entry of config.scripts) {
        if (!entry?.label || !entry?.script) continue;
        if (seenLabels.has(entry.label)) continue;

        seenLabels.add(entry.label);
        createButton(entry.label, entry.script, false);

        buttonCount++;
      }
    }

    if (buttonCount === 0) {
      createErrorMessage();
    }
  }

  function registerCommands() {
    const refreshScriptsDisposable = vscode.commands.registerCommand(
      'script-buttons.refreshScripts',
      () => {
        init();
      },
    );

    addDisposable(refreshScriptsDisposable);
  }

  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
    (event: vscode.ConfigurationChangeEvent) => {
      if (event.affectsConfiguration(CONFIG_NAMESPACE)) {
        init();
      }
    },
  );
  context.subscriptions.push(configChangeDisposable);

  init();
}

export function deactivate() {}
