# Secrets

Every secret in the repo is managed with [dotenvx](https://dotenvx.com).
Plaintext values never land in git; encrypted ciphertext does. Each
deployment target only needs its own decryption key.

## Files

| file | committed | consumed by | decryption key |
|---|---|---|---|
| `.env.ci` | yes, encrypted | GitHub Actions | `DOTENV_PRIVATE_KEY_CI` |
| `.env.production` | yes, encrypted | prod Hetzner box (decrypted in `infra/prod/deploy.sh`) | `DOTENV_PRIVATE_KEY_PRODUCTION` |
| `.env.preview` | yes, encrypted | dev Hetzner box (decrypted in `infra/preview/deploy.sh`) | `DOTENV_PRIVATE_KEY_PREVIEW` |
| `.env.development` | yes, encrypted | local dev via `infra/dev/setup-env.sh` | `DOTENV_PRIVATE_KEY_DEVELOPMENT` |
| `.env.keys` | **never** — gitignored | local developer toolchain | holds every private key |
| `.env` | gitignored | local/prod runtime plaintext | produced by local bootstrap or `dotenvx decrypt` |

## One-time bootstrap (maintainer)

1. Fill the four plaintext template files (`.env.ci`, `.env.production`,
   `.env.preview`, `.env.development`) with real values. The template
   files already list the keys you need to populate.
2. Encrypt each:
   ```bash
   just secrets-encrypt ci
   just secrets-encrypt production
   just secrets-encrypt preview
   just secrets-encrypt development
   ```
   This replaces each file's plaintext values with ciphertext and
   appends four private keys into `.env.keys` (gitignored).
3. Commit the four now-encrypted files:
   ```bash
   git add .env.ci .env.production .env.preview .env.development
   git commit -m "chore: encrypt per-env secrets"
   ```

## Key distribution

After `.env.keys` exists, distribute the private keys:

| key | where it lives |
|---|---|
| `DOTENV_PRIVATE_KEY_CI` | GitHub → Repo settings → Secrets → Actions |
| `DOTENV_PRIVATE_KEY_PRODUCTION` | prod box: `echo 'export DOTENV_PRIVATE_KEY_PRODUCTION=...' >> /root/.bashrc` |
| `DOTENV_PRIVATE_KEY_PREVIEW` | dev box: same pattern in `/root/.bashrc` |
| `DOTENV_PRIVATE_KEY_DEVELOPMENT` | your laptop: stays in `.env.keys` |

You keep all four in your local `.env.keys`; every other target only
holds the one it needs.

## Common operations

```bash
just secrets-keys production      # list keys in .env.production (no values)
just secrets-show production      # decrypt + print (careful with shoulder surfers)
just secrets-edit production      # decrypt → $EDITOR → re-encrypt
dotenvx set FOO=bar -f .env.ci    # set a single value + re-encrypt
```

## Rotation

To rotate a single service's secret (say `SMITHERS_API_KEY`):

```bash
dotenvx set SMITHERS_API_KEY="$(openssl rand -hex 32)" -f .env.production
git add .env.production && git commit -m "chore: rotate SMITHERS_API_KEY"
# Next release will redeploy with the new value.
```

To rotate the decryption keys themselves, `dotenvx rotate -f .env.<env>`
generates a fresh keypair and re-encrypts the file; then update
`.env.keys` and redistribute the new private key.

## CI model

Every workflow that needs any secret starts with:

```yaml
env:
  DOTENV_PRIVATE_KEY_CI: ${{ secrets.DOTENV_PRIVATE_KEY_CI }}
steps:
  - run: curl -fsS https://dotenvx.sh | sh
  - run: dotenvx run -f .env.ci -- <command that needs env vars>
```

`dotenvx run` injects the decrypted values into the child process's
environment; they never touch disk. For the HETZNER_SSH_PRIVATE_KEY /
DEV_SSH_PRIVATE_KEY case where we need the value written to a file, the
workflow uses `dotenvx get <KEY> -f .env.ci` to emit it.

## Box-side decryption

`infra/prod/deploy.sh` / `infra/preview/deploy.sh` now:
1. rsync the encrypted `.env.<env>` up along with the rest of the tree
2. ssh into the box and decrypt on-host:
   - prod: `dotenvx decrypt -f .env.production -o .env`
   - preview: `dotenvx decrypt -f .env.preview --stdout > /opt/redc-previews/.env`
3. compose reads the resulting plaintext env file normally
4. Plaintext env files stay on the box filesystem (root-readable only,
   `chmod 600`). They're gitignored and rsync-excluded so local edits
   never propagate back.

If `DOTENV_PRIVATE_KEY_<ENV>` isn't exported on the box, the deploy
fails fast with a clear error.
