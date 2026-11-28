/**
 * Tests for the cross-platform install/configure/deploy and teardown scripts
 * under scripts/.
 *
 * SCOPE: fully offline, fast, and side-effect free. We NEVER execute the scripts
 * (they would mutate the host) — we only:
 *   - assert all four new script files exist;
 *   - run `bash -n` on each .sh (POSIX syntax check) and assert exit code 0;
 *   - run shellcheck on each .sh if available (skipped gracefully otherwise);
 *   - assert each script's contents contain the required capability markers.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');

const SETUP_SH = join(SCRIPTS, 'mercury-setup.sh');
const SETUP_PS1 = join(SCRIPTS, 'mercury-setup.ps1');
const TEARDOWN_SH = join(SCRIPTS, 'mercury-teardown.sh');
const TEARDOWN_PS1 = join(SCRIPTS, 'mercury-teardown.ps1');

const SH_SCRIPTS = [SETUP_SH, TEARDOWN_SH];
const ALL_SCRIPTS = [SETUP_SH, SETUP_PS1, TEARDOWN_SH, TEARDOWN_PS1];

function hasShellcheck(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v shellcheck'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('cross-platform install/teardown scripts', () => {
  it('all four script files exist', () => {
    for (const f of ALL_SCRIPTS) {
      expect(existsSync(f), `missing: ${f}`).toBe(true);
    }
  });

  it('each .sh script passes `bash -n` (syntax valid)', () => {
    for (const f of SH_SCRIPTS) {
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
      expect(r.status, `bash -n failed for ${f}: ${r.stderr}`).toBe(0);
    }
  });

  it('each .sh script passes shellcheck (when available)', () => {
    if (!hasShellcheck()) {
      // shellcheck not installed in this environment — skip gracefully.
      return;
    }
    for (const f of SH_SCRIPTS) {
      const r = spawnSync('shellcheck', [f], { encoding: 'utf8' });
      expect(r.status, `shellcheck failed for ${f}:\n${r.stdout}\n${r.stderr}`).toBe(0);
    }
  });

  describe('install script capabilities (.sh and .ps1)', () => {
    for (const f of [SETUP_SH, SETUP_PS1]) {
      it(`${f.endsWith('.ps1') ? 'ps1' : 'sh'} mentions the required install/configure/deploy capabilities`, () => {
        const c = read(f);
        // LLM provider choices
        expect(c).toMatch(/OpenRouter/i);
        expect(c).toMatch(/Ollama/i);
        // model prompt + defaults
        expect(c).toMatch(/openrouter\/openai\/gpt-4o-mini/);
        expect(c).toMatch(/ollama\/llama3\.1/);
        expect(c).toMatch(/[Mm]odel/);
        // Jev decision engine
        expect(c).toMatch(/[Jj]ev/);
        expect(c).toMatch(/decision\.provider/);
        // voice / whisper / piper
        expect(c).toMatch(/whisper/i);
        expect(c).toMatch(/piper/i);
        // setup wizard
        expect(c).toMatch(/mercury setup|setup --username|Merc setup/i);
        // prerequisites
        expect(c).toMatch(/22\.5/);
        expect(c).toMatch(/nodejs\.org/);
      });
    }

    it('install .sh deploys via systemd/launchd', () => {
      const c = read(SETUP_SH);
      expect(c).toMatch(/systemd|systemctl/);
      expect(c).toMatch(/launchd|launchctl/);
    });

    it('install .ps1 deploys via a Scheduled Task', () => {
      const c = read(SETUP_PS1);
      expect(c).toMatch(/Register-ScheduledTask|ScheduledTask/);
    });
  });

  describe('teardown script capabilities (.sh and .ps1)', () => {
    for (const f of [TEARDOWN_SH, TEARDOWN_PS1]) {
      it(`${f.endsWith('.ps1') ? 'ps1' : 'sh'} stops processes and removes data + service`, () => {
        const c = read(f);
        // stop processes
        expect(c).toMatch(/serve/);
        expect(c).toMatch(/pkill|Stop-Process/);
        // remove data home
        expect(c).toMatch(/\.mercury/);
        expect(c).toMatch(/MERCURY_HOME/);
        // remove the service
        if (f.endsWith('.ps1')) {
          expect(c).toMatch(/Unregister-ScheduledTask|ScheduledTask/);
        } else {
          expect(c).toMatch(/systemctl|systemd/);
          expect(c).toMatch(/launchctl|launchd/);
        }
        // non-interactive flag
        expect(c).toMatch(/--yes|-y|-Yes|-Force/);
      });
    }

    it('teardown .sh checks both user and system systemd', () => {
      const c = read(TEARDOWN_SH);
      expect(c).toMatch(/systemctl --user/);
      expect(c).toMatch(/sudo systemctl/);
    });
  });
});
