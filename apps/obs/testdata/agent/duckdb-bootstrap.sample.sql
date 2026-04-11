INSTALL httpfs;
LOAD httpfs;

SET s3_endpoint='http://minio:9000';
SET s3_region='us-east-1';
SET s3_access_key_id='minioadmin';
SET s3_secret_access_key='minioadmin';
SET s3_use_ssl=false;
SET s3_url_style='path';

CREATE OR REPLACE VIEW wide_event_rollups AS
SELECT *
FROM read_json_auto(
  's3://wide-events-rollup/rollup/date=*/hour=*/*.ndjson',
  format='newline_delimited',
  records=true
);

CREATE OR REPLACE VIEW wide_event_raw AS
SELECT *
FROM read_json_auto(
  's3://wide-events-raw/raw/date=*/service=*/*.ndjson',
  format='newline_delimited',
  records=true
);
