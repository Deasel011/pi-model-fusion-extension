import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

function resolvePiPackageRoot(): string | undefined {
  try {
    const entry = process.argv[1];
    if (!entry) return undefined;
    let dir = path.dirname(fs.realpathSync(entry));
    while (dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
        if ((pkg as { name?: string }).name === "@mariozechner/pi-coding-agent") return dir;
      } catch {
        // ignore and keep walking
      }
      dir = path.dirname(dir);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRunnableNodeScript(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

export function getPiSpawnCommand(args: string[]): { command: string; args: string[] } {
  const argv1 = process.argv[1];
  if (argv1) {
    const candidate = path.isAbsolute(argv1) ? argv1 : path.resolve(argv1);
    if (isRunnableNodeScript(candidate)) {
      return { command: process.execPath, args: [candidate, ...args] };
    }
  }

  try {
    const root = resolvePiPackageRoot();
    const packageJsonPath = root
      ? path.join(root, "package.json")
      : require.resolve("@mariozechner/pi-coding-agent/package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      bin?: string | Record<string, string>;
    };
    const binField = packageJson.bin;
    const binPath = typeof binField === "string"
      ? binField
      : binField?.pi ?? Object.values(binField ?? {})[0];
    if (binPath) {
      const fullBinPath = path.resolve(path.dirname(packageJsonPath), binPath);
      if (isRunnableNodeScript(fullBinPath)) {
        return { command: process.execPath, args: [fullBinPath, ...args] };
      }
    }
  } catch {
    // fallback to shell pi command
  }

  return { command: "pi", args };
}
