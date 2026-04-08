#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const outputPath = resolve(
	process.env.WIDE_EVENTS_AGENT_SQL_PATH ??
		".wide-events-agent/duckdb-bootstrap.sql",
);

const sql = `INSTALL httpfs;
LOAD httpfs;

SET s3_endpoint='${process.env.WIDE_EVENTS_S3_ENDPOINT ?? "http://127.0.0.1:9000"}';
SET s3_region='${process.env.WIDE_EVENTS_S3_REGION ?? "us-east-1"}';
SET s3_access_key_id='${process.env.WIDE_EVENTS_S3_ACCESS_KEY_ID ?? "minioadmin"}';
SET s3_secret_access_key='${process.env.WIDE_EVENTS_S3_SECRET_ACCESS_KEY ?? "minioadmin"}';
SET s3_use_ssl=${process.env.WIDE_EVENTS_S3_USE_SSL === "true" ? "true" : "false"};
SET s3_url_style='path';

CREATE OR REPLACE VIEW wide_event_rollups AS
SELECT *
FROM read_json_auto(
  's3://${process.env.WIDE_EVENTS_ROLLUP_BUCKET ?? "wide-events-rollup"}/${process.env.WIDE_EVENTS_ROLLUP_PREFIX ?? "rollup"}/date=*/hour=*/*.ndjson',
  format='newline_delimited',
  records=true
);

CREATE OR REPLACE VIEW wide_event_raw AS
SELECT *
FROM read_json_auto(
  's3://${process.env.WIDE_EVENTS_RAW_BUCKET ?? "wide-events-raw"}/${process.env.WIDE_EVENTS_RAW_PREFIX ?? "raw"}/date=*/service=*/*.ndjson',
  format='newline_delimited',
  records=true
);
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, sql, "utf8");
console.log(outputPath);
