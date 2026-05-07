import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}
