import fs from "fs";
import path from "path";

export function findWorkspaceRoot(startDir: string = __dirname): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (Array.isArray(pkg.workspaces)) {
          return dir;
        }
      } catch {
        // continue climbing
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const WORKSPACE_ROOT = findWorkspaceRoot();
export const API_PACKAGE_ROOT = path.join(WORKSPACE_ROOT, "apps", "api");
