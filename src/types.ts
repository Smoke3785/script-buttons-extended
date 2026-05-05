export interface Disposable {
  dispose(): any;
}

export interface Scripts {
  [key: string]: string;
}

export interface PackageJson {
  scripts: Scripts;
}

export interface ScriptEntry {
  label: string;
  script: string;
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
