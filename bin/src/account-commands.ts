import { createApi } from "@webmux/api-contract";
import { resolve } from "node:path";
import { computeProjectId } from "../../backend/src/adapters/tmux";
import { CommandUsageError, readOptionValue, withConnectionError } from "./cli-args";

export function parseAccountsAddArgs(args: string[]): { name: string; dir: string } | null {
  let name: string | null = null;
  let dir: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      return null;
    }

    if (arg === "--dir" || arg.startsWith("--dir=")) {
      const { value, nextIndex } = readOptionValue(args, index, "--dir");
      dir = value;
      index = nextIndex;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CommandUsageError(`Unknown option: ${arg}`);
    }

    if (name) {
      throw new CommandUsageError(`Unexpected argument: ${arg}`);
    }

    name = arg;
  }

  if (!name) {
    throw new CommandUsageError("Missing required argument: <name>");
  }

  if (!dir) {
    throw new CommandUsageError("Missing required option: --dir <path>");
  }

  return { name, dir };
}

export function parseAccountSetArgs(args: string[]): { account: string | null } | null {
  let name: string | undefined = undefined;
  let hasClear = false;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      return null;
    }

    if (arg === "--clear") {
      hasClear = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CommandUsageError(`Unknown option: ${arg}`);
    }

    if (name !== undefined) {
      throw new CommandUsageError(`Unexpected argument: ${arg}`);
    }

    name = arg;
  }

  if (hasClear && name !== undefined) {
    throw new CommandUsageError("Cannot specify both a name and --clear");
  }

  if (!hasClear && name === undefined) {
    throw new CommandUsageError("Missing required argument: <name> or --clear");
  }

  return { account: hasClear ? null : name! };
}

function getAccountsUsage(): string {
  return [
    "Usage:",
    "  webmux accounts list                         List all configured Claude accounts",
    "  webmux accounts add <name> --dir <path>      Add or update an account",
    "  webmux accounts rm <name>                    Remove an account",
    "",
    "Options:",
    "  --help                                       Show this help message",
  ].join("\n");
}

function getAccountUsage(): string {
  return [
    "Usage:",
    "  webmux account <name>    Set the Claude account for the current project",
    "  webmux account --clear   Clear the account for the current project",
    "",
    "Options:",
    "  --help                   Show this help message",
  ].join("\n");
}

interface AccountCommandContext {
  command: "accounts" | "account";
  args: string[];
  projectDir: string;
  port: number;
}

export async function runAccountCommand(context: AccountCommandContext): Promise<number> {
  const stdout = (message: string) => console.log(message);
  const stderr = (message: string) => console.error(message);
  const api = createApi(`http://localhost:${context.port}`);

  try {
    if (context.command === "accounts") {
      const subcommand = context.args[0];

      if (!subcommand || subcommand === "--help" || subcommand === "-h") {
        stdout(getAccountsUsage());
        return 0;
      }

      if (subcommand === "list") {
        const { preferences } = await withConnectionError(() => api.fetchPreferences(), context.port);
        const accounts = preferences.accounts ?? {};
        const entries = Object.entries(accounts);
        if (entries.length === 0) {
          stdout("No accounts configured.");
        } else {
          for (const [name, { configDir }] of entries) {
            stdout(`${name} -> ${configDir}`);
          }
        }
        return 0;
      }

      if (subcommand === "add") {
        const parsed = parseAccountsAddArgs(context.args.slice(1));
        if (!parsed) {
          stdout([
            "Usage:",
            "  webmux accounts add <name> --dir <path>",
            "",
            "Options:",
            "  --dir <path>   Path to the Claude config directory for this account",
            "  --help         Show this help message",
          ].join("\n"));
          return 0;
        }

        const { preferences } = await withConnectionError(() => api.fetchPreferences(), context.port);
        const { schemaVersion, ...rest } = preferences;
        void schemaVersion;
        const accounts = { ...rest.accounts, [parsed.name]: { configDir: parsed.dir } };
        await withConnectionError(() => api.updatePreferences({ body: { ...rest, accounts } }), context.port);
        stdout(`Added account "${parsed.name}" (${parsed.dir})`);
        return 0;
      }

      if (subcommand === "rm") {
        const name = context.args[1];
        if (!name || name === "--help" || name === "-h") {
          stdout("Usage:\n  webmux accounts rm <name>");
          return 0;
        }

        const { preferences } = await withConnectionError(() => api.fetchPreferences(), context.port);
        const { schemaVersion, ...rest } = preferences;
        void schemaVersion;
        const accounts = { ...(rest.accounts ?? {}) };
        if (!(name in accounts)) {
          stderr(`No account named "${name}" found.`);
          return 1;
        }
        delete accounts[name];
        await withConnectionError(() => api.updatePreferences({ body: { ...rest, accounts } }), context.port);
        stdout(`Removed account "${name}"`);
        return 0;
      }

      stderr(`Unknown subcommand: ${subcommand}\n\n${getAccountsUsage()}`);
      return 1;
    }

    if (context.command === "account") {
      if (context.args[0] === "--help" || context.args[0] === "-h") {
        stdout(getAccountUsage());
        return 0;
      }

      const parsed = parseAccountSetArgs(context.args);
      if (!parsed) {
        stdout(getAccountUsage());
        return 0;
      }

      const projectId = computeProjectId(resolve(context.projectDir));
      await withConnectionError(() =>
        api.updateProject({
          params: { projectId },
          body: { account: parsed.account },
        }),
        context.port,
      );

      if (parsed.account === null) {
        stdout("Cleared account for this project.");
      } else {
        stdout(`Set account to "${parsed.account}" for this project.`);
      }
      return 0;
    }
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  return 0;
}
