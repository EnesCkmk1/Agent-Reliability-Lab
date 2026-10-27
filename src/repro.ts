import { execFile } from "node:child_process";

export function readGitCommit(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: 2000 }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}
