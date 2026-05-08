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
  timeoutMs?: number;
  host?: string;
  port: number;
  id: string;
}

export interface ScriptStep {
  executeAfter?: string | string[];
  reliesOnPort?: PortDependency[];
  reliesOn?: string | string[];
  background?: boolean;
  type: ScriptStepType;
  args?: unknown[];
  command: string;
  id?: string;
}

export interface ScriptEntry {
  script: string | ScriptStep[];
  label: string;
  icon?: string;
}

export interface ScriptButtonsFilter {
  mode: 'whitelist' | 'blacklist';
  contents: string[];
}

export type ScriptSource = 'package' | 'config' | 'both';

export interface ScriptButtonsConfig {
  filter?: ScriptButtonsFilter;
  showNpmInstall?: boolean;
  scripts?: ScriptEntry[];
  sources?: ScriptSource;
}
