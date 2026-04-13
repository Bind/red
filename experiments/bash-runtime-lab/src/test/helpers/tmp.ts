import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}
