import { execFile } from 'node:child_process';

/**
 * API keys live in the macOS Keychain. You add them yourself in Terminal, at a hidden prompt,
 * so a key is never in a file, a command's arguments, a log or this repository.
 */

const SERVICE = 'logseq-ai';

export type Secrets = {
  /** Is there a key? Doesn't read it. */
  has: (name: string) => Promise<boolean>;
  get: (name: string) => Promise<string | null>;
};

function security(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', args, { shell: false, timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      resolve({ ok: !err, out: stdout });
    });
  });
}

export const keychain: Secrets = {
  has: async (name) => (await security(['find-generic-password', '-s', SERVICE, '-a', name])).ok,
  get: async (name) => {
    const r = await security(['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
    const key = r.out.trim();
    return r.ok && key !== '' ? key : null;
  },
};

/** What you run to add or replace a key. It asks for the key at a hidden prompt. */
export function addKeyCommand(name: string): string {
  return `security add-generic-password -U -s ${SERVICE} -a ${name} -w`;
}
