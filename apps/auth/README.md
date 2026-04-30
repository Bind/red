# Auth Service

Self-contained auth service for `red`, promoted from the auth experiment.

## Integration

- Browser and web app authenticate against this service over Better Auth routes at `ALL /api/auth/*`.
- The browser keeps a session cookie with the auth service.
- The BFF calls `POST /session/exchange` with that session cookie to mint a short-lived, audience-bound JWT.
- Downstream services verify those JWTs through `GET /.well-known/jwks.json`.
- Machine-to-machine clients use `POST /oauth/token` and the related introspection/revocation endpoints.

The important separation is:
- Better Auth session cookies are for browser/user sessions.
- JWTs are for service-to-service authorization.

## Runtime Surface

- `GET /health`
- `GET /me`
- `GET /.well-known/jwks.json`
- `GET /.well-known/openid-configuration`
- `ALL /api/auth/*`
- `POST /session/exchange`
- `POST /oauth/token`
- `POST /oauth/introspect`
- `POST /oauth/revoke`
- `POST /user/two-factor/enroll`
- `POST /user/two-factor/verify`
- `POST /user/totp-login`
- `POST /user/onboarding/complete`
- `POST /user/recovery/start`
- `POST /login-attempts`
- `GET /login-attempts/:id`
- `POST /login-attempts/redeem`
- `POST /magic-link/complete`

Test-only when enabled:
- `GET /__test__/mailbox/latest`

## Local Use

```bash
just auth-install
just auth-serve
just auth-test
just auth-lint
just auth-format
just auth-compose-e2e
```

Compose mode is strict:
- all required env vars must be set explicitly in `docker-compose.yml`
- boot should fail fast on missing or malformed config

## MVP TODOs

- Remove the remaining test-only mailbox dependency from the production integration story.
- Replace any remaining service-owned shortcuts with fully route-driven onboarding and recovery transitions.
- Finalize the passwordless TOTP enrollment path and recovery completion path.
- Replace in-memory M2M revocation tracking with durable storage.
- Remove or rotate local development signing material before any real deployment.
