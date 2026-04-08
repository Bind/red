import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSql(relativePath: string) {
	return readFileSync(
		resolve(import.meta.dir, "..", "store", relativePath),
		"utf8",
	).trim();
}

export const schemaSql = readSql("schema.sql");
export const canonicalRequestsSql = readSql("canonical-requests.sql");
export const incidentCandidatesSql = readSql("incident-candidates.sql");
