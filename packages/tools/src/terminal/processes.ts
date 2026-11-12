/**
 * Background process manager (Hermes `process` tool): start long-running commands
 * (dev servers, watchers), read their output later, and kill them.
 * Processes are owned by the user who started them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { newId } from '@mercury/core';

export interface ManagedProcess {
  id: string;
  userId: string;
  command: string;
  startedAt: string;
  exitCode: number | null;
  running: boolean;
  output: string;
  child: ChildProcess;
}

const MAX_BUFFER = 100_000;

export class ProcessManager {
  private procs = new Map<string, ManagedProcess>();

  start(userId: string, argv: string[], cwd: string, command: string): ManagedProcess {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    const p: ManagedProcess = { id: newId('proc'), userId, command, startedAt: new Date().toISOString(), exitCode: null, running: true, output: '', child };
    const append = (d: Buffer) => (p.output = (p.output + d.toString()).slice(-MAX_BUFFER));
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('close', (code) => {
      p.running = false;
      p.exitCode = code;
    });
    child.on('error', (err) => {
      p.running = false;
      p.output += `\n[error] ${String(err)}`;
    });
    this.procs.set(p.id, p);
    return p;
  }

  list(userId?: string): ManagedProcess[] {
    return [...this.procs.values()].filter((p) => !userId || p.userId === userId);
  }

  get(id: string, userId?: string): ManagedProcess | undefined {
    const p = this.procs.get(id);
    return p && (!userId || p.userId === userId) ? p : undefined;
  }

  kill(id: string, userId?: string): boolean {
    const p = this.get(id, userId);
    if (!p) return false;
    p.child.kill('SIGTERM');
    setTimeout(() => p.running && p.child.kill('SIGKILL'), 3000).unref();
    return true;
  }

  killAll(): void {
    for (const p of this.procs.values()) if (p.running) p.child.kill('SIGKILL');
  }
}
