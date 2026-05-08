export interface Disposable {
  dispose(): any;
}

export interface Scripts {
  [key: string]: string;
}

export interface PackageJson {
  scripts: Scripts;
}

export type ScriptStepType = 'shell' | 'vscode';

export interface PortDependency {
  id: string;
  port: number;
  host?: string;
  timeoutMs?: number;
}

export interface ScriptStep {
  id?: string;
  type: ScriptStepType;
  command: string;
  args?: unknown[];
  reliesOn?: string | string[];
  executeAfter?: string | string[];
  reliesOnPort?: PortDependency[];
  background?: boolean;
}

export interface ScriptEntry {
  label: string;
  script: string | ScriptStep[];
  icon?: string;
}

export interface ScriptButtonsFilter {
  mode: 'whitelist' | 'blacklist';
  contents: string[];
}

export type ScriptSource = 'package' | 'config' | 'both';

export interface ScriptButtonsConfig {
  sources?: ScriptSource;
  filter?: ScriptButtonsFilter;
  scripts?: ScriptEntry[];
  showNpmInstall?: boolean;
}
