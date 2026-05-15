/**
 * Dependency orchestrator for running script steps with complex dependencies, including waiting for ports.
 */

// Dependencies
import vscode from 'vscode';
import net from 'net';

// Internals
import { asArray } from './lib';

// Types
import type { ScriptStep } from './types';

type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface OrchestratorDeps {
  output: vscode.OutputChannel;
  cwd: string | undefined;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

function stepLabel(step: ScriptStep, index: number): string {
  return step.id ?? `#${index}`;
}

export function validateSteps(scriptSteps: ScriptStep[]): ValidationResult {
  if (!Array.isArray(scriptSteps) || scriptSteps.length === 0) {
    return { ok: false, reason: 'steps must be a non-empty array' };
  }

  const seenIds = new Set<string>();

  // Basic validation and ID collection
  for (let i = 0; i < scriptSteps.length; i++) {
    const s = scriptSteps[i];

    // Step is not an object or is null
    if (!s || typeof s !== 'object') {
      return { ok: false, reason: `step ${i} is not an object` };
    }

    // Missing/invalid step type
    if (s.type !== 'shell' && s.type !== 'vscode') {
      return {
        ok: false,
        reason: `step ${i} has invalid type "${(s as { type?: unknown }).type}" (expected "shell" or "vscode")`,
      };
    }

    // Missing/invalid command
    if (typeof s.command !== 'string' || s.command.length === 0) {
      return { ok: false, reason: `step ${stepLabel(s, i)} has empty/missing command` };
    }

    // Invalid args because...
    if (s.id !== undefined) {
      // Missing/invalid id
      if (typeof s.id !== 'string' || s.id.length === 0) {
        return { ok: false, reason: `step ${i} has invalid id` };
      }

      // Duplicate id
      if (seenIds.has(s.id)) {
        return { ok: false, reason: `duplicate step id "${s.id}"` };
      }

      seenIds.add(s.id);
    }

    // reliesOn and executeAfter must be string or array of strings
    if (s.reliesOnPort !== undefined) {
      if (!Array.isArray(s.reliesOnPort)) {
        return {
          ok: false,
          reason: `step ${stepLabel(s, i)} reliesOnPort must be an array`,
        };
      }

      for (const entry of s.reliesOnPort) {
        if (!entry || typeof entry !== 'object') {
          return {
            ok: false,
            reason: `step ${stepLabel(s, i)} has invalid reliesOnPort entry (not an object)`,
          };
        }

        if (typeof entry.id !== 'string' || entry.id.length === 0) {
          return {
            ok: false,
            reason: `step ${stepLabel(s, i)} has reliesOnPort entry with missing/invalid id`,
          };
        }

        if (
          typeof entry.port !== 'number' ||
          !Number.isInteger(entry.port) ||
          entry.port > 65535 ||
          entry.port < 1
        ) {
          return {
            ok: false,
            reason: `step ${stepLabel(s, i)} reliesOnPort "${entry.id}" has invalid port (must be integer 1-65535)`,
          };
        }

        if (entry.host !== undefined && (typeof entry.host !== 'string' || !entry.host.length)) {
          return {
            reason: `step ${stepLabel(s, i)} reliesOnPort "${entry.id}" has invalid host`,
            ok: false,
          };
        }

        if (
          entry.timeoutMs !== undefined &&
          (typeof entry.timeoutMs !== 'number' || entry.timeoutMs < 0)
        ) {
          return {
            reason: `step ${stepLabel(s, i)} reliesOnPort "${entry.id}" has invalid timeoutMs`,
            ok: false,
          };
        }
      }
    }
  }

  // Topological sort to detect cycles and validate dependencies

  const idToIndex = new Map<string, number>();
  for (let i = 0; i < scriptSteps.length; i++) {
    const id = scriptSteps[i].id;

    if (id) {
      idToIndex.set(id, i);
    }
  }

  const reliesOnIndices: number[][] = scriptSteps.map((s) => {
    return asArray(s.reliesOn).map((id) => {
      return idToIndex.has(id) ? (idToIndex.get(id) as number) : -1;
    });
  });

  const executeAfterIndices: number[][] = scriptSteps.map((s) => {
    return asArray(s.executeAfter).map((id) => {
      if (idToIndex.has(id)) {
        return idToIndex.get(id) as number;
      }

      return -1;
    });
  });

  const reliesOnPortIndices: number[][] = scriptSteps.map((s) => {
    return (s.reliesOnPort ?? []).map((entry) => {
      if (idToIndex.has(entry.id)) {
        return idToIndex.get(entry.id) as number;
      }

      return -1;
    });
  });

  for (let i = 0; i < scriptSteps.length; i++) {
    for (const d of reliesOnIndices[i]) {
      if (d === -1) {
        const missing = asArray(scriptSteps[i].reliesOn).find((id) => !idToIndex.has(id));

        return {
          reason: `step ${stepLabel(scriptSteps[i], i)} reliesOn unknown id "${missing}"`,
          ok: false,
        };
      }

      if (d === i) {
        return { ok: false, reason: `step ${stepLabel(scriptSteps[i], i)} reliesOn itself` };
      }
    }

    for (const d of executeAfterIndices[i]) {
      if (d === -1) {
        const missing = asArray(scriptSteps[i].executeAfter).find((id) => !idToIndex.has(id));

        return {
          reason: `step ${stepLabel(scriptSteps[i], i)} executeAfter unknown id "${missing}"`,
          ok: false,
        };
      }

      if (d === i) {
        return { ok: false, reason: `step ${stepLabel(scriptSteps[i], i)} executeAfter itself` };
      }
    }

    for (let j = 0; j < reliesOnPortIndices[i].length; j++) {
      const entry = (scriptSteps[i].reliesOnPort ?? [])[j];
      const d = reliesOnPortIndices[i][j];

      if (d === -1) {
        return {
          reason: `step ${stepLabel(scriptSteps[i], i)} reliesOnPort references unknown id "${entry.id}"`,
          ok: false,
        };
      }

      if (d === i) {
        return {
          reason: `step ${stepLabel(scriptSteps[i], i)} reliesOnPort references itself`,
          ok: false,
        };
      }
    }
  }

  const allDeps: number[][] = scriptSteps.map((_, i) => {
    const set = new Set<number>([
      ...reliesOnIndices[i],
      ...executeAfterIndices[i],
      ...reliesOnPortIndices[i],
    ]);

    return [...set];
  });

  const dependents: number[][] = scriptSteps.map(() => []);
  const inDegree = allDeps.map((d) => d.length);

  for (let i = 0; i < scriptSteps.length; i++) {
    for (const d of allDeps[i]) {
      dependents[d].push(i);
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < scriptSteps.length; i++) {
    if (inDegree[i] === 0) {
      queue.push(i);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const i = queue.shift() as number;
    processed++;

    for (const d of dependents[i]) {
      inDegree[d]--;
      if (inDegree[d] === 0) {
        queue.push(d);
      }
    }
  }

  if (processed !== scriptSteps.length) {
    return { ok: false, reason: 'cycle detected in step dependency graph' };
  }

  return { ok: true };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;

  const promise = new Promise<void>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function probePort(port: number, host: string, connectTimeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }

      settled = true;

      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(connectTimeoutMs);

    socket.once('timeout', () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));

    socket.connect(port, host);
  });
}

type WaitForPortParams = {
  timeoutMs: number | undefined;
  depDone: Promise<void>;
  intervalMs?: number;
  host: string;
  port: number;
};
async function waitForPort({
  intervalMs = 250,
  timeoutMs,
  depDone,
  port,
  host,
}: WaitForPortParams): Promise<boolean> {
  let depFinished = false;
  depDone.then(
    () => {
      depFinished = true;
    },
    () => {
      depFinished = true;
    },
  );

  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

  while (true) {
    const portActive = await probePort(port, host);

    if (portActive) {
      return true;
    }

    // Could have succeeded long running operation without the port being active, or it could have failed. In either case, we should stop waiting.
    if (depFinished) {
      return await probePort(port, host);
    }

    if (deadline !== undefined && Date.now() >= deadline) {
      return false;
    }

    await new Promise((r) => {
      return setTimeout(r, intervalMs);
    });
  }
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

    if (id) {
      idToIndex.set(id, i);
    }
  }

  const states: StepState[] = steps.map(() => 'pending');

  deps.output.appendLine(`\n[${label}] starting (${steps.length} steps)`);
  deps.output.show(true);

  const stepPromises: Promise<void>[] = [];
  const startedPromises: Promise<void>[] = steps.map(() => {
    return Promise.resolve();
  });
  const startedDeferreds: Deferred[] = steps.map(() => {
    return deferred();
  });

  for (let i = 0; i < steps.length; i++) {
    startedPromises[i] = startedDeferreds[i].promise;
  }

  for (let i = 0; i < steps.length; i++) {
    const index = i;
    const step = steps[index];

    const reliesOnDeps = asArray(step.reliesOn).map((id) => {
      return idToIndex.get(id) as number;
    });

    const executeAfterDeps = asArray(step.executeAfter).map((id) => {
      return idToIndex.get(id) as number;
    });

    const portDeps = (step.reliesOnPort ?? []).map((entry) => {
      return {
        depIndex: idToIndex.get(entry.id) as number,
        host: entry.host ?? 'localhost',
        timeoutMs: entry.timeoutMs,
        port: entry.port,
      };
    });

    const p = (async () => {
      await Promise.all(
        reliesOnDeps.map((d) => {
          return stepPromises[d];
        }),
      );

      await Promise.all(
        executeAfterDeps.map((d) => {
          return startedPromises[d];
        }),
      );

      const reliesOnBlocked = reliesOnDeps.some((d) => {
        return states[d] === 'failed' || states[d] === 'skipped';
      });
      const executeAfterBlocked = executeAfterDeps.some((d) => {
        return states[d] === 'skipped';
      });

      if (reliesOnBlocked || executeAfterBlocked) {
        states[index] = 'skipped';
        startedDeferreds[index].resolve();
        deps.output.appendLine(`[${label}] ${stepLabel(step, index)} skipped (dependency failed)`);

        return;
      }

      if (portDeps.length > 0) {
        const portResults = await Promise.all(
          portDeps.map(async (pd) => {
            await startedPromises[pd.depIndex];
            if (states[pd.depIndex] === 'skipped') {
              return false;
            }

            deps.output.appendLine(
              `[${label}] ${stepLabel(step, index)} waiting for ${pd.host}:${pd.port}`,
            );

            return waitForPort({
              depDone: stepPromises[pd.depIndex],
              timeoutMs: pd.timeoutMs,
              host: pd.host,
              port: pd.port,
            });
          }),
        );

        if (portResults.some((ok) => !ok)) {
          states[index] = 'skipped';
          startedDeferreds[index].resolve();

          deps.output.appendLine(
            `[${label}] ${stepLabel(step, index)} skipped (port dependency not satisfied)`,
          );

          return;
        }
      }

      states[index] = 'running';
      deps.output.appendLine(
        `[${label}] ${stepLabel(step, index)} running: ${step.type} ${step.command}`,
      );

      try {
        if (step.type === 'shell') {
          await runShellStep(label, step, index, deps, () => startedDeferreds[index].resolve());
        } else {
          startedDeferreds[index].resolve();
          await runVscodeStep(step);
        }

        states[index] = 'done';
        deps.output.appendLine(`[${label}] ${stepLabel(step, index)} done`);
      } catch (err) {
        states[index] = 'failed';
        startedDeferreds[index].resolve();

        const msg = err instanceof Error ? err.message : String(err);

        deps.output.appendLine(`[${label}] ${stepLabel(step, index)} failed: ${msg}`);
      }
    })();

    stepPromises.push(p);
  }

  await Promise.all(stepPromises);

  const skippedCount = states.filter((s) => s === 'skipped').length;
  const failedCount = states.filter((s) => s === 'failed').length;
  const doneCount = states.filter((s) => s === 'done').length;

  deps.output.appendLine(
    `[${label}] finished: ${doneCount} done, ${failedCount} failed, ${skippedCount} skipped`,
  );

  if (failedCount > 0 || skippedCount > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Script Buttons "${label}" finished with ${failedCount} failed, ${skippedCount} skipped`,
      'Show Output',
    );

    if (choice === 'Show Output') {
      deps.output.show();
    }
  }
}

let taskCounter = 0;

function runShellStep(
  label: string,
  step: ScriptStep,
  index: number,
  deps: OrchestratorDeps,
  onStarted: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const taskId = `script-buttons-${Date.now()}-${++taskCounter}`;
    const taskName = `${label} :: ${stepLabel(step, index)}`;

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
      reveal: step.background ? vscode.TaskRevealKind.Never : vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      showReuseMessage: false,
      focus: false,
      clear: false,
      echo: true,
    };

    let started = false;
    const fireStarted = () => {
      if (started) return;

      started = true;
      onStarted();
    };

    const startSub = vscode.tasks.onDidStartTaskProcess((e) => {
      const def = e.execution.task.definition as { id?: string };
      if (def.id !== taskId) return;
      startSub.dispose();
      fireStarted();
    });

    const endSub = vscode.tasks.onDidEndTaskProcess((e) => {
      const def = e.execution.task.definition as { id?: string };
      if (def.id !== taskId) return;

      startSub.dispose();
      endSub.dispose();
      fireStarted();

      if (e.exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`exit code ${e.exitCode ?? 'unknown'}`));
      }
    });

    vscode.tasks.executeTask(task).then(undefined, (err) => {
      startSub.dispose();
      endSub.dispose();
      fireStarted();

      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function runVscodeStep(step: ScriptStep): Promise<void> {
  const args = (step.args ?? []) as unknown[];
  await vscode.commands.executeCommand(step.command, ...args);
}
