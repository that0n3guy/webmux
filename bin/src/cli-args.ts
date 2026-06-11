export class CommandUsageError extends Error {}

export function readOptionValue(args: string[], index: number, flag: string): {
  value: string;
  nextIndex: number;
} {
  const arg = args[index];
  if (!arg) {
    throw new CommandUsageError(`${flag} requires a value`);
  }

  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) {
    return {
      value: arg.slice(prefix.length),
      nextIndex: index,
    };
  }

  const value = args[index + 1];
  if (value === undefined) {
    throw new CommandUsageError(`${flag} requires a value`);
  }

  return {
    value,
    nextIndex: index + 1,
  };
}

export async function withConnectionError<T>(fn: () => Promise<T>, port: number): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("HTTP")) {
      throw error;
    }
    if (error instanceof Error && !error.message.includes("fetch")) {
      throw error;
    }
    throw new Error(`Could not connect to webmux server on port ${port}. Is it running?`);
  }
}
