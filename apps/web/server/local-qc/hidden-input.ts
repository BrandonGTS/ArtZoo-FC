import { emitKeypressEvents } from 'node:readline';

/** Never echoes characters, including phones; only prompts and a trailing newline are written. */
export async function readHiddenLine(
  prompt: string,
  options: { maxLength: number; accepts: RegExp },
  io = { input: process.stdin, output: process.stdout }
): Promise<string> {
  const { input, output } = io;
  if (!input.isTTY || !output.isTTY) throw new Error('Direct local TTY required');
  output.write(prompt);
  emitKeypressEvents(input);
  const previousRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '',
      done = false;
    function finish(error?: Error) {
      if (done) return;
      done = true;
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.off('close', onEnd);
      try {
        input.setRawMode(previousRaw);
        input.pause();
      } catch {
        /* Terminal may close on cancellation. */
      }
      output.write('\n');
      const result = value;
      value = '';
      if (error) reject(error);
      else resolve(result);
    }
    function onEnd() {
      finish(new Error('Input cancelled'));
    }
    function onKey(character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        onEnd();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && character && options.accepts.test(character)) value += character;
      if (value.length > options.maxLength) finish(new Error('Input too long; cancelled'));
    }
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('close', onEnd);
  });
}
