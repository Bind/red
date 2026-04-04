# JWKS Auth Lab

Small Bun experiment for issuing and verifying JWTs with a published JWKS using `jose`.

## Endpoints

- `GET /health`
- `GET /.well-known/jwks.json`
- `GET /.well-known/openid-configuration`
- `POST /token`
- `GET /protected`

## Defaults

- issuer: `http://127.0.0.1:4010`
- audience: `redc-jwks-lab`
- alg: `RS256`

## Run

```bash
just jwks-auth-lab-install
just jwks-auth-lab-serve
```

## Issue a token

```bash
curl -s http://127.0.0.1:4010/token \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"sub":"alice","scope":"read:changes"}'
```

## Call a protected route

```bash
TOKEN="$(curl -s http://127.0.0.1:4010/token -X POST -H 'content-type: application/json' -d '{"sub":"alice"}' | jq -r '.token')"
curl -s http://127.0.0.1:4010/protected -H "authorization: Bearer ${TOKEN}"
```
