// Dependencies
import { promises as fsPromises } from 'fs';
import { workspace } from 'vscode';
import vscode from 'vscode';

// Internals
import { runSteps, validateSteps } from './orchestrator';

// Types
import type {
  ScriptButtonsConfig,
  ScriptButtonsFilter,
  ScriptSource,
  ScriptEntry,
  ScriptStep,
  PackageJson,
  Disposable,
  Scripts,
} from './types';

// Constants
import { CONFIG_NAMESPACE, SCHEMA_URL } from './constants';

const { readFile } = fsPromises;

export function activate(context: vscode.ExtensionContext) {
  const disposables: Disposable[] = [];

  const terminals: { [name: string]: vscode.Terminal } = {};

  const output = vscode.window.createOutputChannel('Script Buttons');
  const cwd = getWorkspaceFolderPath();

  context.subscriptions.push(output);

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

  async function getScriptButtonsFile(): Promise<{
    config: ScriptButtonsConfig;
    path: string;
  } | null> {
    if (!cwd) return null;
    const candidates = [`${cwd}/script-buttons.json`, `${cwd}/.vscode/script-buttons.json`];

    for (const path of candidates) {
      try {
        const raw = await getJsonFile<unknown>(path);
        return { config: normalizeFileShape(raw), path };
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

    // Legacy flat dict: { name: command, ... } - wrap as scripts list.
    // $schema is reserved metadata and must not become a button.
    const scripts: ScriptEntry[] = Object.entries(obj)
      .filter(([k, v]) => {
        return k !== '$schema' && typeof v === 'string';
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
    const fileResult = await getScriptButtonsFile();
    const file = fileResult?.config ?? {};
    if (fileResult) await maybeInjectSchema(fileResult.path);

    const settings = readSettingsConfig();

    const merged = mergeConfigs(settings, file);

    return {
      filter: merged.filter ?? { mode: 'blacklist', contents: [] },
      showNpmInstall: merged.showNpmInstall ?? true,
      sources: merged.sources ?? 'both',
      scripts: merged.scripts ?? [],
    };
  }

  function injectSchemaInRawJson(raw: string, schemaUrl: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if ('$schema' in (parsed as Record<string, unknown>)) return null;

    const openMatch = raw.match(/^[\s﻿]*\{/);
    if (!openMatch) return null;
    const openEnd = openMatch[0].length;
    const after = raw.slice(openEnd);

    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const indentMatch = after.match(/[\r\n]+([ \t]+)/);
    const indent = indentMatch ? indentMatch[1] : '  ';

    const schemaLine = `"$schema": ${JSON.stringify(schemaUrl)}`;

    const emptyMatch = after.match(/^\s*\}/);
    if (emptyMatch) {
      return (
        raw.slice(0, openEnd) +
        newline +
        indent +
        schemaLine +
        newline +
        '}' +
        after.slice(emptyMatch[0].length)
      );
    }

    return raw.slice(0, openEnd) + newline + indent + schemaLine + ',' + after;
  }

  async function maybeInjectSchema(filePath: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    if (cfg.get<boolean>('autoInsertSchema') === false) return;

    let raw: string;
    try {
      raw = (await readFile(filePath)).toString();
    } catch {
      return;
    }

    const updated = injectSchemaInRawJson(raw, SCHEMA_URL);
    if (updated === null || updated === raw) return;

    try {
      await fsPromises.writeFile(filePath, updated, 'utf8');
      output.appendLine(`Inserted $schema into ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`Failed to insert $schema into ${filePath}: ${msg}`);
    }
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

  function createButton(label: string, command: string | ScriptStep[], isNpm: boolean) {
    const vscCommand = createVscCommand(command, label, isNpm);
    const color = isNpm ? 'white' : undefined;
    const tooltip = typeof command === 'string' ? command : `${command.length} steps`;

    createStatusBarItem(label, tooltip, vscCommand, color);
  }

  function createVscCommand(command: string | ScriptStep[], name: string, isNpm = false) {
    const prefix = isNpm ? 'npm-' : 'custom-';
    const vscCommand = `script-buttons.${prefix}${name.replace(/\s+/g, '_')}`;

    const commandDisposable = vscode.commands.registerCommand(vscCommand, async () => {
      if (typeof command === 'string') {
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
        return;
      }

      await runSteps(name, command, { cwd, output });
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

        const isArrayForm = Array.isArray(entry.script);
        if (isArrayForm) {
          const validation = validateSteps(entry.script as ScriptStep[]);
          if (!validation.ok) {
            output.appendLine(`[${entry.label}] skipped: ${validation.reason}`);
            continue;
          }
        } else if (typeof entry.script !== 'string' || entry.script.length === 0) {
          continue;
        }

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
