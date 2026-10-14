import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CliUsageError } from "./cli-commands";

export class CliCanceledError extends Error {}

async function readAnswer(
  question: string,
  hidden: boolean,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new CliCanceledError();
  const output = hidden
    ? new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    : process.stderr;
  const input = createInterface({
    input: process.stdin,
    output,
    // Keep raw input enabled even when the hidden output is not a TTY.
    terminal: true,
    historySize: 0,
  });
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  let failed = false;
  const fail = (): void => {
    failed = true;
    cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  input.once("SIGINT", cancel);
  input.once("close", cancel);
  input.once("error", fail);
  try {
    if (hidden) process.stderr.write(question);
    return await input.question(hidden ? "" : question, {
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted && !failed) throw new CliCanceledError();
    throw new CliUsageError(
      "Could not read terminal input. Check your terminal and try again.",
    );
  } finally {
    signal?.removeEventListener("abort", cancel);
    input.removeListener("SIGINT", cancel);
    input.removeListener("close", cancel);
    input.removeListener("error", fail);
    input.close();
    if (hidden) {
      output.destroy();
      process.stderr.write("\n");
    }
  }
}

export async function confirmAction(
  question: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CliUsageError(
      `${question}\nNo request was sent. Add --yes if you intend to run this action from a script.`,
    );
  }
  return (
    (await readAnswer(`${question} Type yes to continue: `, false, signal))
      .trim()
      .toLowerCase() === "yes"
  );
}

export async function promptSecret(
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CliUsageError(
      "API key input needs a terminal. Run netcup ccp login in an interactive terminal and try again.",
    );
  }
  return readAnswer(question, true, signal);
}
