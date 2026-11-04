import { readFile, stat, unlink } from 'node:fs/promises';
import { writeFileAtomic } from './config.ts';

/**
 * Your own instructions for the AI ("custom instructions"), edited in the panel.
 *
 * Stored in <data>/instructions.md (mode 0600), outside the repo and outside Logseq, so
 * each person on each Mac account has their own. They're added to the end of the built-in
 * system prompt on every turn. The built-in rules on privacy, approvals and treating notes
 * as data stay first and win; those are also enforced in code, whatever the prompt says.
 */

export const MAX_INSTRUCTION_CHARS = 8000;

export class InstructionsError extends Error {}

/** Normalizes line endings, drops control characters (keeps newlines and tabs), trims. */
export function cleanInstructions(raw: unknown): string {
  if (typeof raw !== 'string') throw new InstructionsError('"text" must be a string');
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (text.length > MAX_INSTRUCTION_CHARS) throw new InstructionsError(`instructions are too long (max ${MAX_INSTRUCTION_CHARS} characters)`);
  return text;
}

/** The built-in prompt, then your instructions, then the memory section (memory.ts), as claude gets it. */
export function systemPromptWith(base: string, user: string, memory = ''): string {
  let out = base;
  if (user.trim() !== '') {
    // Your text can't close the block early and look like a rule after it.
    const safe = user.replace(/<\/?\s*user_instructions\s*>/gi, (m) => m.replace('<', '‹').replace('>', '›'));
    out =
      `${out.trimEnd()}\n\n` +
      "The user's own instructions follow. Follow them: they take precedence over the working and style guidance above " +
      '(language, length, tone, format, how to use the notes), but not over the privacy, approval and safety rules.\n' +
      `<user_instructions>\n${safe}\n</user_instructions>\n`;
  }
  return memory === '' ? out : `${out.trimEnd()}\n\n${memory}`;
}

export class Instructions {
  readonly file: string;
  readonly builtIn: string;

  constructor(opts: { file: string; builtIn: string }) {
    this.file = opts.file;
    this.builtIn = opts.builtIn;
  }

  async get(): Promise<{ text: string; updatedAt: number | null }> {
    try {
      const [text, st] = await Promise.all([readFile(this.file, 'utf8'), stat(this.file)]);
      return { text: cleanInstructions(text), updatedAt: st.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', updatedAt: null };
      if (err instanceof InstructionsError) return { text: '', updatedAt: null }; // a broken file is ignored, not half-used
      throw err;
    }
  }

  /** Saves (empty = delete). Returns what was stored. */
  async set(raw: unknown): Promise<{ text: string; updatedAt: number | null }> {
    const text = cleanInstructions(raw);
    if (text === '') {
      await unlink(this.file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      return { text: '', updatedAt: null };
    }
    await writeFileAtomic(this.file, text + '\n');
    return this.get();
  }

  /** What a turn sends as the system prompt (plus the memory section, if any). */
  async systemPrompt(memory = ''): Promise<string> {
    return systemPromptWith(this.builtIn, (await this.get()).text, memory);
  }
}
