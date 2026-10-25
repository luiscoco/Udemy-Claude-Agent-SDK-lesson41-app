import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
export async function prepareWorkspace() {
  const parent = resolve(realpathSync.native(tmpdir()), "claude-sdk41"),
    root = resolve(parent, randomUUID());
  const safe = () => {
    const p = relative(parent, root);
    if (!p || p.startsWith("..") || isAbsolute(p))
      throw new Error("Invalid classroom workspace.");
  };
  safe();
  const cwd = join(root, "project"),
    home = join(root, "home"),
    sdkHome = join(root, "source-sdk"),
    targetSdk = join(root, "target-sdk"),
    storeRoot = join(root, "external-store");
  for (const p of [cwd, home, sdkHome, targetSdk, storeRoot])
    await mkdir(p, { recursive: true });
  await writeFile(join(cwd, "lesson.txt"), "CURRENT-41");
  const scan = async (dir: string): Promise<string[]> => {
    const files: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) files.push(...(await scan(path)));
      else if (e.name.endsWith(".jsonl")) files.push(relative(root, path));
    }
    return files;
  };
  return {
    cwd,
    home,
    sdkHome,
    targetSdk,
    storeRoot,
    async inspect() {
      return { source: await scan(sdkHome), target: await scan(targetSdk) };
    },
    async eraseSource() {
      safe();
      await rm(sdkHome, { recursive: true, force: true });
      await mkdir(sdkHome);
    },
    async cleanup() {
      safe();
      await rm(root, { recursive: true, force: true });
    },
  };
}
