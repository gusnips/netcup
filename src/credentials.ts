import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./errors";

class CredentialStoreError extends Error {}

const unix = process.platform !== "win32";

export class CredentialStore {
  readonly path: string;
  private readonly directory: string;
  private readonly name: string;
  private readonly field: "refreshToken" | "apiKey";
  private readonly loginCommand: string;

  constructor(
    env: Record<string, string | undefined> = process.env,
    namespace: "scp" | "ccp" = "scp",
  ) {
    const home = env.HOME || env.USERPROFILE || homedir();
    const base = unix
      ? env.XDG_CONFIG_HOME || join(home, ".config")
      : env.APPDATA || join(env.USERPROFILE || home, "AppData", "Roaming");
    this.directory = join(base, "netcup-sdk");
    this.name = namespace === "scp" ? "credentials" : "ccp-credentials";
    this.field = namespace === "scp" ? "refreshToken" : "apiKey";
    this.loginCommand =
      namespace === "scp" ? "netcup login" : "netcup ccp login";
    this.path = join(this.directory, `${this.name}.json`);
  }

  async read(): Promise<string | undefined> {
    try {
      if (!(await this.checkDirectory(false))) return undefined;
      this.check(await lstat(this.path), this.path, false);
      const file = await open(
        this.path,
        constants.O_RDONLY |
          (unix ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0),
      );
      let contents: string;
      try {
        this.check(await file.stat(), this.path, false);
        contents = await file.readFile("utf8");
      } finally {
        await file.close();
      }

      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch {
        throw this.invalidFile();
      }
      if (!isRecord(value) || Object.keys(value).length !== 1) {
        throw this.invalidFile();
      }
      const secret = value[this.field];
      if (typeof secret !== "string" || !secret.trim()) {
        throw this.invalidFile();
      }
      return secret;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw this.sanitize(error, "read");
    }
  }

  async save(secret: string, expectedSecret: string | null): Promise<void> {
    if (typeof secret !== "string" || !secret.trim()) {
      throw new CredentialStoreError(
        `Cannot save an empty ${this.field === "refreshToken" ? "refresh token" : "API key"}. Run ${this.loginCommand} again.`,
      );
    }
    await this.withLock(true, async () => {
      this.compare(await this.read(), expectedSecret);
      const temporaryPath = join(
        this.directory,
        `.${this.name}.${randomUUID()}.tmp`,
      );
      const file = await open(temporaryPath, "wx", 0o600);
      let renamed = false;
      try {
        try {
          await file.writeFile(
            `${JSON.stringify({ [this.field]: secret })}\n`,
            "utf8",
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporaryPath, this.path);
        renamed = true;
      } finally {
        if (!renamed) await unlink(temporaryPath);
      }
    });
  }

  async remove(expectedSecret: string): Promise<void> {
    await this.withLock(false, async () => {
      const current = await this.read();
      if (current === undefined) return;
      this.compare(current, expectedSecret);
      await unlink(this.path);
    });
  }

  private compare(
    current: string | undefined,
    expectedSecret: string | null,
  ): void {
    if ((current ?? null) !== expectedSecret) {
      throw new CredentialStoreError(
        `The saved login at ${this.path} changed in another command. Nothing was overwritten. Retry your command to use the current login.`,
      );
    }
  }

  private async checkDirectory(create: boolean): Promise<boolean> {
    if (create) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    try {
      this.check(await lstat(this.directory), this.directory, true);
      return true;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT" && !create) return false;
      throw error;
    }
  }

  private check(info: Stats, path: string, directory: boolean): void {
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile())
    ) {
      throw new CredentialStoreError(
        `${path} must be a real ${directory ? "folder" : "file"}, not a link or another file type. Move it aside and run ${this.loginCommand} again.`,
      );
    }
    if (unix && process.getuid && info.uid !== process.getuid()) {
      throw new CredentialStoreError(
        `${path} belongs to another user. Use a config folder you own or ask its owner to fix ownership, then try again.`,
      );
    }
    if (unix && (info.mode & 0o077) !== 0) {
      throw new CredentialStoreError(
        `${path} allows access by other users. Set its permissions to ${directory ? "700" : "600"} with chmod, then try again.`,
      );
    }
  }

  private async withLock(
    createDirectory: boolean,
    change: () => Promise<void>,
  ): Promise<void> {
    const lockPath = join(this.directory, `.${this.name}.lock`);
    try {
      if (!(await this.checkDirectory(createDirectory))) return;
      const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
        if (isRecord(error) && error.code === "EEXIST") {
          // ponytail: a killed process can leave this lock; use OS advisory locking if automatic recovery becomes necessary.
          throw new CredentialStoreError(
            `Another command is updating the saved login. Try again. If no Netcup command is running, remove ${lockPath} and retry.`,
          );
        }
        throw error;
      });
      try {
        await change();
      } finally {
        try {
          await lock.close();
        } finally {
          await unlink(lockPath);
        }
      }
    } catch (error) {
      throw this.sanitize(error, "update");
    }
  }

  private invalidFile(): Error {
    return new CredentialStoreError(
      `The credentials file at ${this.path} is not valid. Remove that file and run ${this.loginCommand} again.`,
    );
  }

  private sanitize(error: unknown, action: string): Error {
    return error instanceof CredentialStoreError
      ? error
      : new CredentialStoreError(
          `Could not ${action} credentials at ${this.path}. Check folder permissions and free disk space, then try again.`,
        );
  }
}
