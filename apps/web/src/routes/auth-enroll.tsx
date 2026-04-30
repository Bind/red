import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  completeOnboarding,
  enrollTotp,
  fetchPasskeyAuthenticateOptions,
  fetchPasskeyRegisterOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  verifyTotp,
  type AuthMeResponse,
  type TotpEnrollment,
} from "@/lib/api";
import { getAuthLifecycleState, useAuthSession } from "@/lib/auth";
import {
  creationOptionsFromJson,
  requestOptionsFromJson,
  serializeAuthenticationCredential,
  serializeRegistrationCredential,
} from "@/lib/webauthn";

const WEB_CLIENT_ID = "red-web";

function parseApiMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function parseTotpSecret(totpUri: string): string {
  const uri = new URL(totpUri);
  return uri.searchParams.get("secret") ?? "";
}

function PasskeyEnrollmentCard({ onComplete }: { onComplete: () => Promise<void> }) {
  const [status, setStatus] = useState<"idle" | "working" | "error" | "done">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleEnroll = async () => {
    if (
      !window.PublicKeyCredential ||
      !navigator.credentials?.create ||
      !navigator.credentials?.get
    ) {
      setStatus("error");
      setMessage("This browser does not support passkey enrollment.");
      return;
    }

    setStatus("working");
    setMessage("Creating your passkey.");

    try {
      const registerOptions = await fetchPasskeyRegisterOptions();
      const registration = await navigator.credentials.create({
        publicKey: creationOptionsFromJson(registerOptions),
      });
      if (!registration) {
        throw new Error("Passkey creation was cancelled.");
      }

      await verifyPasskeyRegistration(serializeRegistrationCredential(registration), "red passkey");

      setMessage("Confirming the new passkey.");
      const authenticateOptions = await fetchPasskeyAuthenticateOptions();
      const assertion = await navigator.credentials.get({
        publicKey: requestOptionsFromJson(authenticateOptions),
      });
      if (!assertion) {
        throw new Error("Passkey confirmation was cancelled.");
      }

      await verifyPasskeyAuthentication(serializeAuthenticationCredential(assertion));
      await onComplete();
      setStatus("done");
      setMessage("Passkey enrolled. Continue to YubiKey TOTP setup.");
    } catch (error) {
      setStatus("error");
      setMessage(parseApiMessage(error, "Unable to enroll a passkey."));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
        This auth flow still requires a primary passkey before recovery-factor setup.
      </div>
      <Button type="button" onClick={() => void handleEnroll()} disabled={status === "working"}>
        {status === "working" ? "Enrolling passkey..." : "Enroll passkey"}
      </Button>
      {message && (
        <Alert variant={status === "error" ? "destructive" : "default"}>
          <AlertTitle>
            {status === "error" ? "Passkey enrollment failed" : "Passkey enrollment"}
          </AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function TotpEnrollmentCard({ onComplete }: { onComplete: () => Promise<void> }) {
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error" | "done">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleStart = async () => {
    setStatus("working");
    setMessage("Creating a TOTP enrollment.");
    try {
      const next = await enrollTotp();
      setEnrollment(next);
      setStatus("idle");
      setMessage(null);
    } catch (error) {
      setStatus("error");
      setMessage(parseApiMessage(error, "Unable to start TOTP enrollment."));
    }
  };

  useEffect(() => {
    let cancelled = false;

    const buildQrCode = async () => {
      if (!enrollment?.totpURI) {
        setQrCodeUrl(null);
        return;
      }
      try {
        const nextQrCodeUrl = await QRCode.toDataURL(enrollment.totpURI, {
          margin: 1,
          width: 224,
        });
        if (!cancelled) {
          setQrCodeUrl(nextQrCodeUrl);
        }
      } catch {
        if (!cancelled) {
          setQrCodeUrl(null);
        }
      }
    };

    void buildQrCode();

    return () => {
      cancelled = true;
    };
  }, [enrollment?.totpURI]);

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("working");
    setMessage("Verifying your TOTP code.");
    try {
      await verifyTotp(code.trim());
      await completeOnboarding();
      await onComplete();
      setStatus("done");
      setMessage("YubiKey TOTP verified. The account is now active.");
    } catch (error) {
      setStatus("error");
      setMessage(parseApiMessage(error, "Unable to verify the TOTP code."));
    }
  };

  return (
    <div className="space-y-4">
      {!enrollment ? (
        <>
          <div className="rounded-md border border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
            Start TOTP setup, then add the secret to YubiKey Authenticator and verify the current
            code.
          </div>
          <Button type="button" onClick={() => void handleStart()} disabled={status === "working"}>
            {status === "working" ? "Preparing TOTP..." : "Start YubiKey TOTP setup"}
          </Button>
        </>
      ) : (
        <form className="space-y-4" onSubmit={handleVerify}>
          <div className="space-y-2 rounded-md border border-border/60 bg-background/60 p-4">
            <p className="text-sm text-muted-foreground">
              Add this secret or `otpauth` URI to YubiKey Authenticator, then enter the current
              6-digit code.
            </p>
            {qrCodeUrl && (
              <div className="rounded-md border border-border/60 bg-background/70 p-3">
                <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
                  Scan with YubiKey Authenticator
                </p>
                <img
                  src={qrCodeUrl}
                  alt="TOTP QR code"
                  className="mx-auto h-56 w-56 rounded-sm bg-white p-2"
                />
              </div>
            )}
            <div className="rounded-md border border-border/60 bg-background/70 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Secret</p>
              <p className="break-all font-mono text-sm text-foreground">
                {parseTotpSecret(enrollment.totpURI)}
              </p>
            </div>
            <div className="rounded-md border border-border/60 bg-background/70 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">URI</p>
              <p className="break-all font-mono text-xs text-foreground">{enrollment.totpURI}</p>
            </div>
            <div className="rounded-md border border-border/60 bg-background/70 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Backup codes</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {enrollment.backupCodes.map((backupCode) => (
                  <Badge key={backupCode} variant="secondary" className="font-mono">
                    {backupCode}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="totp-code">YubiKey code</Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={status === "working"}>
            {status === "working" ? "Verifying..." : "Verify TOTP and finish setup"}
          </Button>
        </form>
      )}
    </div>
  );
}

function SeedInstructions({ me }: { me: AuthMeResponse }) {
  return (
    <Card className="border-border/60 bg-background/80">
      <CardHeader>
        <CardTitle>Seed this account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          This account is active and can be copied into other environments if they share the same
          `AUTH_LAB_BETTER_AUTH_SECRET`.
        </p>
        <div className="rounded-md border border-border/60 bg-background/60 p-4">
          <p className="font-medium text-foreground">Copy from auth DB</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>`user` row for `{me.user.email}`</li>
            <li>matching `passkey` rows for that `user.id`</li>
            <li>`recoveryTotpSecretEncrypted` and `recoveryBackupCodesEncrypted` fields</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export function AuthEnrollPage() {
  const { me, status: sessionStatus, refreshSession, startLoginAttempt, peekMagicLink } =
    useAuthSession();
  const [email, setEmail] = useState("douglasjbinder@gmail.com");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [mailboxPreview, setMailboxPreview] = useState<string | null>(null);

  const lifecycleState = getAuthLifecycleState(sessionStatus, me);

  const handleSendMagicLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("working");
    setMessage("Sending magic link.");
    try {
      const normalizedEmail = email.trim().toLowerCase();
      await startLoginAttempt(normalizedEmail, WEB_CLIENT_ID);
      const preview = await peekMagicLink(normalizedEmail);
      setMailboxPreview(preview?.url ?? null);
      setStatus("idle");
      setMessage("Magic link sent. Open it, then return to this page.");
    } catch (error) {
      setStatus("error");
      setMailboxPreview(null);
      setMessage(parseApiMessage(error, "Unable to send the magic link."));
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Auth Enrollment</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Use this local page to bootstrap a passkey and YubiKey TOTP account, then copy the auth
          DB rows into a seed script.
        </p>
      </div>

      <Card className="border-border/60 bg-background/80">
        <CardHeader>
          <CardTitle>Current session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={me ? "default" : "secondary"}>
              {sessionStatus === "loading" ? "Loading" : lifecycleState}
            </Badge>
            {me ? (
              <span>{me.user.email}</span>
            ) : (
              <span className="text-muted-foreground">Signed out</span>
            )}
          </div>
          {status !== "idle" && message ? (
            <Alert variant={status === "error" ? "destructive" : "default"}>
              <AlertTitle>{status === "error" ? "Action failed" : "Status"}</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {!me ? (
        <Card className="border-border/60 bg-background/80">
          <CardHeader>
            <CardTitle>1. Magic link sign-in</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSendMagicLink}>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={status === "working"}>
                {status === "working" ? "Sending..." : "Send magic link"}
              </Button>
            </form>
            {mailboxPreview ? (
              <div className="mt-4 rounded-md border border-border/60 bg-background/60 p-4 text-sm">
                <p className="font-medium text-foreground">Dev mailbox preview</p>
                <a className="mt-2 block text-primary underline" href={mailboxPreview}>
                  {mailboxPreview}
                </a>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {me && lifecycleState === "pending_passkey" ? (
        <Card className="border-border/60 bg-background/80">
          <CardHeader>
            <CardTitle>2. Enroll passkey</CardTitle>
          </CardHeader>
          <CardContent>
            <PasskeyEnrollmentCard onComplete={refreshSession} />
          </CardContent>
        </Card>
      ) : null}

      {me && lifecycleState === "pending_recovery_factor" ? (
        <Card className="border-border/60 bg-background/80">
          <CardHeader>
            <CardTitle>3. Enroll YubiKey TOTP</CardTitle>
          </CardHeader>
          <CardContent>
            <TotpEnrollmentCard onComplete={refreshSession} />
          </CardContent>
        </Card>
      ) : null}

      {me && lifecycleState === "active" ? <SeedInstructions me={me} /> : null}
    </div>
  );
}
