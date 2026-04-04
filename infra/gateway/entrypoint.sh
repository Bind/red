#!/bin/sh
set -e
envsubst '${FORGEJO_HOST} ${API_HOST}' < /etc/envoy/envoy.yaml.template > /etc/envoy/envoy.yaml
exec envoy -c /etc/envoy/envoy.yaml
