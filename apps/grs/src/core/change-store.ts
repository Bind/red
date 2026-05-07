import type { ChangeRecord, ChangeStore } from "./api";

export class InMemoryChangeStore implements ChangeStore {
  private readonly records = new Map<string, ChangeRecord>();
  private nextId = 1;

  create(change: Omit<ChangeRecord, "id">): Promise<ChangeRecord> {
    const record = { ...change, id: `change-${this.nextId++}` };
    this.records.set(record.id, record);
    return Promise.resolve(record);
  }

  get(id: string): Promise<ChangeRecord | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }
}
