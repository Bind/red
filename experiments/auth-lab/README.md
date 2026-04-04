# Auth Lab

Self-contained auth service prototype with two lanes:

- Better Auth-backed user auth runtime
- OAuth-style machine auth for M2M

HTTP routing is handled by Hono. The routes stay thin and delegate lifecycle
and session-exchange behavior to service-layer code.

## User Auth Runtime

The browser talks to Better Auth through `/api/auth/*` using session cookies.
The auth service also exposes `/session/exchange`, which resolves the current
session cookie and mints a short-lived service JWT for downstream services.

Mounted Better Auth plugins:

- magic link
- passkey
- jwt for service-facing tokens only

Storage:

- dedicated auth DB for durable Better Auth tables
- no Redis in this experiment

App-owned state fields:

- `user.onboardingState`
- `user.recoveryReady`
- `user.recoveryChallengePending`
- `user.authAssurance`
- `session.sessionKind`
- `session.authPurpose`
- `session.secondFactorVerified`

The user policy bridge remains in `src/user-auth-policy.ts`.
That file still owns the onboarding and recovery state machine for the
experiment. The mounted Better Auth runtime is real, but the full passkey and
2FA ceremony is still intentionally narrow.

Current behavior:

1. request magic link
2. verify email with magic link
3. create bootstrap session
4. register first passkey with the virtual passkey authenticator in tests
5. enroll a recovery factor through `/user/two-factor/enroll`
6. verify it through the auth-lab-owned `/user/two-factor/verify` route
7. complete onboarding through `/user/onboarding/complete`
8. exchange an authenticated session for a short-lived service JWT

Recovery:

- active users get a recovery challenge from magic link
- magic link alone never grants account takeover
- recovery requires magic link plus TOTP or backup code
- recovery-start marks the durable `user.recoveryChallengePending` flag
- recovery sessions without the second factor cannot change email, reset passkeys, or disable recovery factors

## Session Exchange

`POST /session/exchange` is the BFF bridge.

- authenticated by Better Auth session cookie
- validates the session and user state
- denies bootstrap-only sessions
- denies recovery-challenge sessions without second factor
- returns a short-lived audience-bound JWT
- includes `sid`, `email`, `amr`, `onboarding_state`, and `recovery_ready` when available

Downstream services verify the JWT with `/.well-known/jwks.json`.
They do not parse Better Auth cookies.

## M2M

Machine auth stays isolated.

Endpoints:

- `GET /health`
- `GET /.well-known/jwks.json`
- `GET /.well-known/openid-configuration`
- `POST /oauth/token`
- `POST /oauth/introspect`
- `POST /oauth/revoke`

## Compose E2E

The Compose stack uses an explicit auth DB container plus the auth service container.
All required auth env vars are set in `docker-compose.yml`. The Compose path is
fail-fast: missing issuer, base URL, Better Auth secret, DB URL, or signing key
configuration stops boot instead of silently falling back. The signing key file
is generated locally by `just auth-lab-compose-keygen` and is ignored by git.

The Compose-only helper is a test utility, not a product route:

- `GET /__test__/mailbox/latest`

That route is enabled only when `AUTH_LAB_EXPOSE_TEST_MAILBOX=true`.
It exists so Compose E2E can retrieve the delivered magic-link payload without
introducing a separate email service.

User lifecycle routes:

- `POST /user/two-factor/enroll`
- `POST /user/two-factor/verify`
- `POST /user/onboarding/complete`
- `POST /user/recovery/start`

Those routes are service-owned, not test-only. They bridge the passwordless
experiment into Better Auth's durable storage and factor verification flow.
TOTP enrollment and verification are handled by the auth-lab runtime rather
than Better Auth's password-oriented 2FA plugin.

Compose E2E then follows the real Better Auth magic-link verification route and
captures the session cookie from the real response. The passkey ceremony is
browserless but real: tests use `src/test/helpers/virtual-passkey-authenticator.ts`
to drive Better Auth's passkey registration and authentication routes.

## Run

```bash
just auth-lab-install
just auth-lab-serve
just auth-lab-lint
just auth-lab-compose-e2e
```

## Local Client

The server seeds a dev client by default:

- `client_id`: `claw-runner-dev`
- `client_secret`: set `AUTH_LAB_BOOTSTRAP_CLIENT_SECRET` to pin it

## Env

Dev/in-process mode:

- `AUTH_LAB_DB_PATH`: SQLite file path for the auth DB
- `AUTH_LAB_BETTER_AUTH_SECRET`: Better Auth secret for user auth
- `AUTH_LAB_BOOTSTRAP_CLIENT_SECRET`: M2M bootstrap client secret

Compose mode:

- `AUTH_LAB_HOST`
- `AUTH_LAB_PORT`
- `AUTH_LAB_ISSUER`
- `AUTH_LAB_AUDIENCE`
- `AUTH_LAB_DB_URL`
- `AUTH_LAB_BETTER_AUTH_SECRET`
- `AUTH_LAB_SIGNING_PRIVATE_JWK_FILE`
- `AUTH_LAB_BOOTSTRAP_CLIENT_ID`
- `AUTH_LAB_BOOTSTRAP_CLIENT_SECRET`
- `AUTH_LAB_BOOTSTRAP_SCOPES`
- `AUTH_LAB_BOOTSTRAP_AUDIENCES`
- `AUTH_LAB_BOOTSTRAP_TTL_SECONDS`
- `AUTH_LAB_EXPOSE_TEST_MAILBOX=true`

## Notes

- Redis is not used in this experiment.
- User auth is mounted now; the policy bridge is still the app-owned guardrail.
- `jwt` is for service-facing tokens, not browser sessions.
- Client secrets are hashed at rest in the in-memory registry model.
- Startup does not print secrets by default.
- Compose E2E is intentionally strict and fails fast on config problems.
- The onboarding and recovery policy is still partially scaffolded around the Better Auth runtime, not fully wired to every end-user ceremony yet.
- `src/test/helpers/virtual-passkey-authenticator.ts` is test-only, ES256-only, uses `attestation: "none"`, and keeps credential state in memory for browserless passkey verification tests.
- The magic-link mailbox is the only fake delivery layer; passkey registration and authentication routes are exercised through Better Auth in tests.
- Better Auth's password-oriented 2FA plugin is not used here; auth-lab owns TOTP enrollment and verification so the passwordless flow stays explicit and honest.
- The account activation and recovery challenge transitions now happen through service routes rather than test-side state patching.
