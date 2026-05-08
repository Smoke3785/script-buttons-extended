import vscode from 'vscode';

import type { ScriptStep } from './types';

type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface OrchestratorDeps {
  cwd: string | undefined;
  output: vscode.OutputChannel;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function stepLabel(step: ScriptStep, index: number): string {
  return step.id ?? `#${index}`;
}

export function validateSteps(steps: ScriptStep[]): ValidationResult {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, reason: 'steps must be a non-empty array' };
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') {
      return { ok: false, reason: `step ${i} is not an object` };
    }
    if (s.type !== 'shell' && s.type !== 'vscode') {
      return {
        ok: false,
        reason: `step ${i} has invalid type "${(s as { type?: unknown }).type}" (expected "shell" or "vscode")`,
      };
    }
    if (typeof s.command !== 'string' || s.command.length === 0) {
      return { ok: false, reason: `step ${stepLabel(s, i)} has empty/missing command` };
    }
    if (s.id !== undefined) {
      if (typeof s.id !== 'string' || s.id.length === 0) {
        return { ok: false, reason: `step ${i} has invalid id` };
      }
      if (seenIds.has(s.id)) {
        return { ok: false, reason: `duplicate step id "${s.id}"` };
      }
      seenIds.add(s.id);
    }
  }

  const idToIndex = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const id = steps[i].id;
    if (id) idToIndex.set(id, i);
  }

  const depIndices: number[][] = steps.map((s) => {
    return asArray(s.reliesOn).map((id) => {
      return idToIndex.has(id) ? (idToIndex.get(id) as number) : -1;
    });
  });

  for (let i = 0; i < steps.length; i++) {
    for (const d of depIndices[i]) {
      if (d === -1) {
        const missing = asArray(steps[i].reliesOn).find((id) => !idToIndex.has(id));
        return {
          ok: false,
          reason: `step ${stepLabel(steps[i], i)} depends on unknown id "${missing}"`,
        };
      }
      if (d === i) {
        return { ok: false, reason: `step ${stepLabel(steps[i], i)} depends on itself` };
      }
    }
  }

  const inDegree = depIndices.map((d) => d.length);
  const dependents: number[][] = steps.map(() => []);
  for (let i = 0; i < steps.length; i++) {
    for (const d of depIndices[i]) dependents[d].push(i);
  }
  const queue: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }
  let processed = 0;
  while (queue.length > 0) {
    const i = queue.shift() as number;
    processed++;
    for (const d of dependents[i]) {
      inDegree[d]--;
      if (inDegree[d] === 0) queue.push(d);
    }
  }
  if (processed !== steps.length) {
    return { ok: false, reason: 'cycle detected in reliesOn graph' };
  }

  return { ok: true };
}

export async function runSteps(
  label: string,
  steps: ScriptStep[],
  deps: OrchestratorDeps,
): Promise<void> {
  const validation = validateSteps(steps);
  if (!validation.ok) {
    deps.output.appendLine(`[${label}] invalid script: ${validation.reason}`);
    vscode.window.showErrorMessage(`Script Buttons "${label}": ${validation.reason}`);
    return;
  }

  const idToIndex = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const id = steps[i].id;
    if (id) idToIndex.set(id, i);
  }

  const states: StepState[] = steps.map(() => 'pending');

  deps.output.appendLine(`\n[${label}] starting (${steps.length} steps)`);
  deps.output.show(true);

  const stepPromises: Promise<void>[] = [];

  for (let i = 0; i < steps.length; i++) {
    const index = i;
    const step = steps[index];
    const myDeps = asArray(step.reliesOn).map((id) => idToIndex.get(id) as number);

    const p = (async () => {
      await Promise.all(myDeps.map((d) => stepPromises[d]));

      const blocked = myDeps.some((d) => states[d] === 'failed' || states[d] === 'skipped');
      if (blocked) {
        states[index] = 'skipped';
        deps.output.appendLine(`[${label}] ${stepLabel(step, index)} skipped (dependency failed)`);
        return;
      }

      states[index] = 'running';
      deps.output.appendLine(
        `[${label}] ${stepLabel(step, index)} running: ${step.type} ${step.command}`,
      );

      try {
        if (step.type === 'shell') {
          await runShellStep(label, step, index, deps);
        } else {
          await runVscodeStep(step);
        }
        states[index] = 'done';
        deps.output.appendLine(`[${label}] ${stepLabel(step, index)} done`);
      } catch (err) {
        states[index] = 'failed';
        const msg = err instanceof Error ? err.message : String(err);
        deps.output.appendLine(`[${label}] ${stepLabel(step, index)} failed: ${msg}`);
      }
    })();

    stepPromises.push(p);
  }

  await Promise.all(stepPromises);

  const doneCount = states.filter((s) => s === 'done').length;
  const failedCount = states.filter((s) => s === 'failed').length;
  const skippedCount = states.filter((s) => s === 'skipped').length;
  deps.output.appendLine(
    `[${label}] finished: ${doneCount} done, ${failedCount} failed, ${skippedCount} skipped`,
  );

  if (failedCount > 0 || skippedCount > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Script Buttons "${label}" finished with ${failedCount} failed, ${skippedCount} skipped`,
      'Show Output',
    );
    if (choice === 'Show Output') deps.output.show();
  }
}

let taskCounter = 0;

function runShellStep(
  label: string,
  step: ScriptStep,
  index: number,
  deps: OrchestratorDeps,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const taskName = `${label} :: ${stepLabel(step, index)}`;
    const taskId = `script-buttons-${Date.now()}-${++taskCounter}`;

    const execution = new vscode.ShellExecution(
      step.command,
      deps.cwd ? { cwd: deps.cwd } : undefined,
    );
    const task = new vscode.Task(
      { type: 'script-buttons', id: taskId, label: taskName },
      vscode.TaskScope.Workspace,
      taskName,
      'Script Buttons',
      execution,
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: false,
      echo: true,
      focus: false,
      showReuseMessage: false,
    };

    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      const def = e.execution.task.definition as { id?: string };
      if (def.id !== taskId) return;
      sub.dispose();
      if (e.exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`exit code ${e.exitCode ?? 'unknown'}`));
      }
    });

    vscode.tasks.executeTask(task).then(undefined, (err) => {
      sub.dispose();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function runVscodeStep(step: ScriptStep): Promise<void> {
  const args = (step.args ?? []) as unknown[];
  await vscode.commands.executeCommand(step.command, ...args);
}
