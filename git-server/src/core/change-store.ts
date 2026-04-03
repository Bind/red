import type { ChangeRecord, ChangeStore } from "./api";

export class InMemoryChangeStore implements ChangeStore {
  private readonly records = new Map<string, ChangeRecord>();
  private nextId = 1;

  async create(change: Omit<ChangeRecord, "id">): Promise<ChangeRecord> {
    const record = { ...change, id: `change-${this.nextId++}` };
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<ChangeRecord | null> {
    return this.records.get(id) ?? null;
  }
}
