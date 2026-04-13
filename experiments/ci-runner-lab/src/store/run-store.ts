import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AttemptRecord, JobRecord, JobSpec, JobStore } from "../util/types";

interface StateFile {
  jobs: JobRecord[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class FileJobStore implements JobStore {
  private data: StateFile;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = this.load();
    this.flush();
  }

  listJobs(): JobRecord[] {
    return this.data.jobs.map((job) => clone(job));
  }

  getJob(jobId: string): JobRecord | undefined {
    const record = this.data.jobs.find((entry) => entry.job.jobId === jobId);
    return record ? clone(record) : undefined;
  }

  getAttempt(attemptId: string): { job: JobSpec; attempt: AttemptRecord } | undefined {
    for (const record of this.data.jobs) {
      const attempt = record.attempts.find((entry) => entry.attemptId === attemptId);
      if (attempt) {
        return {
          job: clone(record.job),
          attempt: clone(attempt),
        };
      }
    }
    return undefined;
  }

  createJob(job: JobSpec, attempt: AttemptRecord): JobRecord {
    const record: JobRecord = {
      job: clone(job),
      attempts: [clone(attempt)],
    };
    this.data.jobs.unshift(record);
    this.flush();
    return clone(record);
  }

  createRetryAttempt(jobId: string, attempt: AttemptRecord): JobRecord {
    const record = this.data.jobs.find((entry) => entry.job.jobId === jobId);
    if (!record) {
      throw new Error(`job ${jobId} not found`);
    }
    record.attempts.push(clone(attempt));
    this.flush();
    return clone(record);
  }

  updateAttempt(
    attemptId: string,
    updater: (attempt: AttemptRecord, job: JobSpec) => AttemptRecord,
  ): AttemptRecord {
    for (const record of this.data.jobs) {
      const index = record.attempts.findIndex((entry) => entry.attemptId === attemptId);
      if (index === -1) {
        continue;
      }

      const current = record.attempts[index];
      if (!current) {
        break;
      }

      const next = updater(clone(current), clone(record.job));
      record.attempts[index] = clone(next);
      this.flush();
      return clone(next);
    }

    throw new Error(`attempt ${attemptId} not found`);
  }

  private load(): StateFile {
    if (!existsSync(this.filePath)) {
      return { jobs: [] };
    }

    const raw = readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return { jobs: [] };
    }

    const parsed = JSON.parse(raw) as Partial<StateFile>;
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((job) => clone(job)) : [],
    };
  }

  private flush() {
    writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}
