import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class FilesystemRunStore {
  constructor(private readonly dbPath: string) {}

  init(): void {
    mkdirSync(this.dataDir, { recursive: true });
  }

  getDbPath(): string {
    return this.dbPath;
  }

  get dataDir(): string {
    return dirname(this.dbPath);
  }
}
