#!/bin/sh
set -e
: "${API_HOST:=api}"
: "${AUTH_HOST:=auth}"
: "${BFF_HOST:=bff}"
: "${OBS_HOST:=obs}"
: "${TRIAGE_HOST:=triage}"
: "${GRS_HOST:=grs}"
: "${WEB_HOST:=web}"
: "${MCP_HOST:=mcp}"
export API_HOST AUTH_HOST BFF_HOST OBS_HOST TRIAGE_HOST GRS_HOST WEB_HOST MCP_HOST

envsubst '${API_HOST} ${AUTH_HOST} ${BFF_HOST} ${OBS_HOST} ${TRIAGE_HOST} ${GRS_HOST} ${WEB_HOST} ${MCP_HOST}' \
  < /etc/envoy/envoy.yaml.template > /etc/envoy/envoy.yaml
exec envoy -c /etc/envoy/envoy.yaml
