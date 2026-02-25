/** Read key=value pairs from a worktree's .env.local file. */
export function readEnvLocal(wtDir: string): Record<string, string> {
  try {
    const content = Bun.spawnSync(["cat", `${wtDir}/.env.local`], { stdout: "pipe" });
    const text = new TextDecoder().decode(content.stdout).trim();
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) env[match[1]] = match[2];
    }
    return env;
  } catch {
    return {};
  }
}


/** Upsert a key=value pair in a worktree's .env.local file. */
export function upsertEnvLocal(wtDir: string, key: string, value: string): void {
  const filePath = `${wtDir}/.env.local`;
  const file = Bun.file(filePath);
  let lines: string[] = [];
  try {
    const text = Bun.spawnSync(["cat", filePath], { stdout: "pipe" });
    const content = new TextDecoder().decode(text.stdout).trim();
    if (content) lines = content.split("\n");
  } catch {
    // File doesn't exist yet, start with empty lines
  }

  const pattern = new RegExp(`^${key}=`);
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }

  Bun.write(file, lines.join("\n") + "\n");
}
