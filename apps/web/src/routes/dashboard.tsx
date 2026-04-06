import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import QRCode from "qrcode";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  completeOnboarding,
  createRepo,
  enrollTotp,
  fetchBranches,
  fetchPasskeyAuthenticateOptions,
  fetchPasskeyRegisterOptions,
  fetchRepos,
  fetchReviewQueue,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  verifyTotp,
  type AuthMeResponse,
  type Branch,
  type Change,
  type LoginAttempt,
  type MagicLinkPreview,
  type RepoSummary,
  type RepoVisibility,
  type TotpEnrollment,
} from "@/lib/api";
import { getAuthLifecycleState, useAuthSession } from "@/lib/auth";
import {
  creationOptionsFromJson,
  requestOptionsFromJson,
  serializeAuthenticationCredential,
  serializeRegistrationCredential,
} from "@/lib/webauthn";

const WEB_CLIENT_ID = "redc-web";

function timeAgo(dateStr: string): string {
  const normalized = dateStr.includes("T") || dateStr.includes("Z") ? dateStr : `${dateStr}Z`;
  const seconds = Math.floor((Date.now() - new Date(normalized).getTime()) / 1000);
  if (Number.isNaN(seconds) || seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "ready_for_review":
    case "scoring":
    case "summarizing":
      return "secondary";
    case "superseded":
      return "outline";
    default:
      return "outline";
  }
}

function confidenceVariant(
  confidence: string | null,
): "default" | "secondary" | "destructive" | "outline" {
  switch (confidence) {
    case "safe":
      return "default";
    case "needs_review":
      return "secondary";
    case "critical":
      return "destructive";
    default:
      return "outline";
  }
}

function deriveDefaultOwner(email: string): string {
  const localPart = email.split("@")[0]?.trim();
  return localPart || "redc";
}

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
    if (!window.PublicKeyCredential || !navigator.credentials?.create || !navigator.credentials?.get) {
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

      await verifyPasskeyRegistration(
        serializeRegistrationCredential(registration),
        "redc passkey",
      );

      setMessage("Confirming the new passkey.");
      const authenticateOptions = await fetchPasskeyAuthenticateOptions();
      const assertion = await navigator.credentials.get({
        publicKey: requestOptionsFromJson(authenticateOptions),
      });
      if (!assertion) {
        throw new Error("Passkey confirmation was cancelled.");
      }

      await verifyPasskeyAuthentication(serializeAuthenticationCredential(assertion));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await onComplete();
        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }
      setStatus("done");
      setMessage("Passkey enrolled. Moving to recovery-factor setup.");
    } catch (error) {
      setStatus("error");
      setMessage(parseApiMessage(error, "Unable to enroll a passkey."));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
        Create and verify a passkey in this browser to activate passwordless sign-in.
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
      setMessage("Recovery factor verified. Your account is now active.");
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
            Set up a recovery factor so account recovery requires more than email access.
          </div>
          <Button type="button" onClick={() => void handleStart()} disabled={status === "working"}>
            {status === "working" ? "Preparing TOTP..." : "Start TOTP setup"}
          </Button>
        </>
      ) : (
        <form className="space-y-4" onSubmit={handleVerify}>
          <div className="space-y-2 rounded-md border border-border/60 bg-background/60 p-4">
            <p className="text-sm text-muted-foreground">
              Add this secret or `otpauth` URI to your authenticator app, then enter the current code.
            </p>
            {qrCodeUrl && (
              <div className="rounded-md border border-border/60 bg-background/70 p-3">
                <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
                  Scan with your authenticator
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
            <Label htmlFor="totp-code">Authenticator code</Label>
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
      {message && (
        <Alert variant={status === "error" ? "destructive" : "default"}>
          <AlertTitle>
            {status === "error" ? "Recovery-factor setup failed" : "Recovery-factor setup"}
          </AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function AuthGate({
  me,
  lifecycle,
  onRefresh,
  onStartLoginAttempt,
  onPollLoginAttempt,
  onRedeemLoginGrant,
  onPeekMagicLink,
}: {
  me: AuthMeResponse | null;
  lifecycle: ReturnType<typeof getAuthLifecycleState>;
  onRefresh: () => Promise<void>;
  onStartLoginAttempt: (email: string, clientId: string) => Promise<LoginAttempt>;
  onPollLoginAttempt: (attemptId: string) => Promise<LoginAttempt>;
  onRedeemLoginGrant: (attemptId: string, loginGrant: string) => Promise<void>;
  onPeekMagicLink: (email: string) => Promise<MagicLinkPreview | null>;
}) {
  const [email, setEmail] = useState(me?.user.email ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<LoginAttempt | null>(null);
  const [mailboxPreview, setMailboxPreview] = useState<MagicLinkPreview | null>(null);
  const [mailboxMessage, setMailboxMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingMailbox, setLoadingMailbox] = useState(false);
  const [redeeming, setRedeeming] = useState(false);

  useEffect(() => {
    if (!email && me?.user.email) {
      setEmail(me.user.email);
    }
  }, [email, me?.user.email]);

  const handleSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    setMailboxMessage(null);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const nextAttempt = await onStartLoginAttempt(normalizedEmail, WEB_CLIENT_ID);
      setAttempt(nextAttempt);
      setMessage(
        "Magic link requested. This page will keep polling until the login attempt is completed.",
      );
      const preview = await onPeekMagicLink(normalizedEmail);
      setMailboxPreview(preview);
      if (!preview) {
        setMailboxMessage("Dev mailbox preview is not enabled for this environment.");
      }
    } catch (err) {
      setError(parseApiMessage(err, "Unable to request sign-in link."));
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!attempt || lifecycle !== "signed_out") {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const next = await onPollLoginAttempt(attempt.attempt_id);
        if (cancelled) return;
        setAttempt(next);
        if (next.status === "completed" && next.login_grant && !redeeming) {
          try {
            setRedeeming(true);
            await onRedeemLoginGrant(next.attempt_id, next.login_grant);
            if (cancelled) return;
            await onRefresh();
            if (cancelled) return;
            setMessage("Session established. Refresh complete.");
            setAttempt(null);
          } finally {
            if (!cancelled) {
              setRedeeming(false);
            }
          }
          return;
        }
        if (next.status === "expired") {
          setError("This login attempt expired. Request a new magic link.");
          setAttempt(null);
          return;
        }
      } catch (err) {
        if (!cancelled) {
          setError(parseApiMessage(err, "Unable to poll login attempt."));
        }
      }
    };

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [attempt, lifecycle, onPollLoginAttempt, onRedeemLoginGrant, onRefresh, redeeming]);

  const handlePeekMagicLink = async () => {
    const normalizedEmail = (email.trim() || me?.user.email || "").toLowerCase();
    if (!normalizedEmail) {
      setMailboxPreview(null);
      setMailboxMessage("Enter an email address first.");
      return;
    }
    setLoadingMailbox(true);
    setMailboxMessage(null);
    try {
      const preview = await onPeekMagicLink(normalizedEmail);
      setMailboxPreview(preview);
      if (!preview) {
        setMailboxMessage("No dev mailbox entry found yet for that email.");
      }
    } catch (err) {
      setMailboxPreview(null);
      setMailboxMessage(parseApiMessage(err, "Unable to load the latest magic link."));
    } finally {
      setLoadingMailbox(false);
    }
  };

  const title =
    lifecycle === "signed_out"
      ? "Sign in to continue"
      : lifecycle === "pending_passkey"
        ? "Finish passkey enrollment"
        : lifecycle === "pending_recovery_factor"
          ? "Finish recovery-factor setup"
          : lifecycle === "error"
            ? "Session unavailable"
            : "Loading session";

  const description =
    lifecycle === "signed_out"
      ? "Authenticate with your magic link, then the dashboard will unlock automatically."
      : lifecycle === "pending_passkey"
        ? "Your account is authenticated, but the primary passkey step is not complete yet."
        : lifecycle === "pending_recovery_factor"
          ? "Your account has a passkey, but recovery-factor enrollment still needs to be completed."
          : lifecycle === "error"
            ? "The auth service responded with an unexpected error. Wait a moment while the session retries automatically."
            : "Checking the current session state.";

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-2xl items-center">
      <Card className="w-full border-primary/20 bg-gradient-to-br from-primary/10 via-card to-background">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{lifecycle.replace(/_/g, " ")}</Badge>
            {me?.user.email && <Badge variant="secondary">{me.user.email}</Badge>}
          </div>
          <CardTitle className="text-2xl">{title}</CardTitle>
          <p className="text-sm text-muted-foreground">{description}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {lifecycle === "signed_out" && (
            <form className="space-y-4" onSubmit={handleSignIn}>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Requesting..." : "Send magic link"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handlePeekMagicLink()}
                  disabled={loadingMailbox}
                >
                  {loadingMailbox ? "Loading link..." : "Show latest link"}
                </Button>
              </div>
              {message && (
                <Alert>
                  <AlertTitle>Check your email</AlertTitle>
                  <AlertDescription>{message}</AlertDescription>
                </Alert>
              )}
              {(mailboxPreview || mailboxMessage) && (
                <Alert>
                  <AlertTitle>Dev mailbox</AlertTitle>
                  <AlertDescription>
                    {mailboxPreview ? (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          Latest generated magic link for <span className="font-mono">{mailboxPreview.email}</span>
                        </p>
                        <div className="rounded-md border border-border/60 bg-background/70 p-3">
                          <a
                            href={mailboxPreview.url}
                            className="break-all font-mono text-xs text-foreground hover:underline"
                          >
                            {mailboxPreview.url}
                          </a>
                        </div>
                        <p className="font-mono text-xs text-muted-foreground">
                          token: {mailboxPreview.token}
                        </p>
                      </div>
                    ) : (
                      mailboxMessage
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </form>
          )}

          {lifecycle !== "signed_out" && (
            <div className="space-y-3">
              <div className="rounded-md border border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
                {lifecycle === "pending_passkey" && (
                  <PasskeyEnrollmentCard onComplete={onRefresh} />
                )}
                {lifecycle === "pending_recovery_factor" && (
                  <TotpEnrollmentCard onComplete={onRefresh} />
                )}
                {lifecycle === "error" && (
                  <p>
                    The session could not be loaded. Automatic retries are still running, or you
                    can request a new magic link.
                  </p>
                )}
                {lifecycle === "loading" && <p>Loading the current user session.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {(email.trim() || me?.user.email) && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void handlePeekMagicLink()}
                  >
                    Show latest link
                  </Button>
                )}
              </div>
              {attempt && (
                <Alert>
                  <AlertTitle>Login attempt active</AlertTitle>
                  <AlertDescription>
                    <div className="space-y-1">
                      <p className="font-mono text-xs">attempt: {attempt.attempt_id}</p>
                      <p className="text-sm text-muted-foreground">
                        status: {attempt.status}
                        {attempt.session_id ? `, session: ${attempt.session_id}` : ""}
                      </p>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Unable to proceed</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RepoCreateCard({
  defaultOwner,
  onCreated,
}: {
  defaultOwner: string;
  onCreated: () => void | Promise<void>;
}) {
  const [owner, setOwner] = useState(defaultOwner);
  const [name, setName] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [visibility, setVisibility] = useState<RepoVisibility>("private");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!owner) {
      setOwner(defaultOwner);
    }
  }, [defaultOwner, owner]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const repo = await createRepo({
        owner: owner.trim(),
        name: name.trim(),
        defaultBranch: defaultBranch.trim() || "main",
        visibility,
      });
      setSuccess(`Created ${repo.full_name}`);
      setName("");
      await onCreated();
    } catch (err) {
      setError(parseApiMessage(err, "Unable to create repository."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create repo</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="repo-owner">Namespace</Label>
            <Input
              id="repo-owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="redc"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-name">Repository name</Label>
            <Input
              id="repo-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="agent-scratch"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-default-branch">Default branch</Label>
            <Input
              id="repo-default-branch"
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
              placeholder="main"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-visibility">Visibility</Label>
            <Select value={visibility} onValueChange={(value) => setVisibility(value as RepoVisibility)}>
              <SelectTrigger id="repo-visibility" className="w-full">
                <SelectValue placeholder="Visibility" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="internal">Internal</SelectItem>
                <SelectItem value="public">Public</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create repository"}
            </Button>
            <span className="text-sm text-muted-foreground">
              The backend is expected to persist this repo record and expose it immediately.
            </span>
          </div>
          {(error || success) && (
            <div className="sm:col-span-2 space-y-2">
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Creation failed</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {success && (
                <Alert>
                  <AlertTitle>Repo created</AlertTitle>
                  <AlertDescription>{success}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function RepoCatalogCard({
  repos,
  loading,
  error,
  onRefresh,
  branches,
  branchesLoading,
}: {
  repos: RepoSummary[] | null;
  loading: boolean;
  error: boolean;
  onRefresh: () => void | Promise<void>;
  branches: Record<string, Branch[]>;
  branchesLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">Repos</CardTitle>
        <Button type="button" size="sm" variant="outline" onClick={() => void onRefresh()}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Unable to load repos</AlertTitle>
            <AlertDescription>Try refreshing the catalog.</AlertDescription>
          </Alert>
        ) : loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : repos && repos.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repo</TableHead>
                  <TableHead>Default branch</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Branches</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repos.map((repo) => {
                  const repoBranches = branches[repo.full_name] ?? [];
                  return (
                    <TableRow key={repo.full_name}>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="font-mono text-sm text-foreground">{repo.full_name}</div>
                          <div className="text-xs text-muted-foreground">
                            {repo.owner}/{repo.name}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {repo.default_branch}
                      </TableCell>
                      <TableCell>
                        <Badge variant={repo.visibility === "public" ? "default" : "secondary"}>
                          {repo.visibility ?? "private"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {branchesLoading ? "Loading..." : `${repoBranches.length} branches`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-6 text-sm text-muted-foreground">
            No repos yet. Create one above to seed the catalog.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardContent({
  me,
}: {
  me: AuthMeResponse;
}) {
  const [queue, setQueue] = useState<Change[] | null>(null);
  const [queueError, setQueueError] = useState(false);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [reposError, setReposError] = useState(false);
  const [branches, setBranches] = useState<Record<string, Branch[]>>({});
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState(false);

  const loadQueue = useCallback(() => {
    fetchReviewQueue()
      .then((data) => {
        setQueue(data);
        setQueueError(false);
      })
      .catch(() => setQueueError(true));
  }, []);

  const loadRepos = useCallback(async () => {
    setReposError(false);
    setBranchesError(false);
    setBranchesLoading(true);
    try {
      const data = await fetchRepos();
      setRepos(data);
      const entries = await Promise.all(
        data.map(async (repo) => {
          try {
            const repoBranches = await fetchBranches(repo.full_name);
            return [repo.full_name, repoBranches] as const;
          } catch {
            return [repo.full_name, [] as Branch[]] as const;
          }
        }),
      );
      setBranches(Object.fromEntries(entries.filter(([, repoBranches]) => repoBranches.length > 0)));
      setReposError(false);
      setBranchesError(false);
    } catch {
      setRepos(null);
      setReposError(true);
      setBranchesError(true);
    } finally {
      setBranchesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
    loadRepos();
    const interval = setInterval(() => {
      loadQueue();
      loadRepos();
    }, 5_000);
    return () => clearInterval(interval);
  }, [loadQueue, loadRepos]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-primary/15 bg-gradient-to-br from-primary/10 via-card to-background">
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{getAuthLifecycleState("authenticated", me)}</Badge>
              <Badge variant="secondary" className="font-mono">
                {me.user.email}
              </Badge>
            </div>
            <CardTitle className="text-2xl">Authenticated dashboard</CardTitle>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Create repos, refresh the catalog, and keep the review queue in view while the
              auth flow remains in sync with the session cookie.
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" asChild>
              <Link to="/theme">Theme demo</Link>
            </Button>
          </CardContent>
        </Card>

        <RepoCreateCard defaultOwner={deriveDefaultOwner(me.user.email)} onCreated={loadRepos} />
      </div>

      <RepoCatalogCard
        repos={repos}
        loading={repos === null}
        error={reposError}
        onRefresh={loadRepos}
        branches={branches}
        branchesLoading={branchesLoading}
      />

      {queueError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Unable to load review queue.</p>
          </CardContent>
        </Card>
      ) : queue === null ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : queue.length === 0 ? (
        <div className="py-4 text-center">
          <p className="text-sm text-muted-foreground">No changes awaiting review.</p>
        </div>
      ) : (
        Object.entries(
          queue.reduce<Record<string, Change[]>>((acc, change) => {
            (acc[change.repo] ??= []).push(change);
            return acc;
          }, {}),
        ).map(([repo, changes]) => (
          <Card key={repo}>
            <CardHeader>
              <CardTitle className="text-base">
                Review Queue{" "}
                <span className="font-mono font-normal text-muted-foreground">{repo}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Branch</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {changes.map((change) => (
                      <TableRow key={change.id}>
                        <TableCell>
                          <Link
                            to={`/changes/${change.id}`}
                            className="font-mono text-sm text-foreground hover:underline"
                          >
                            {change.branch}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(change.status)}>{change.status}</Badge>
                        </TableCell>
                        <TableCell>
                          {change.confidence && (
                            <Badge variant={confidenceVariant(change.confidence)}>
                              {change.confidence}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {change.created_by}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm text-muted-foreground">
                          {timeAgo(change.created_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      {branchesError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Unable to load remote branches.</p>
          </CardContent>
        </Card>
      ) : branchesLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : Object.keys(branches).length === 0 ? null : (
        Object.entries(branches).map(([repo, repoBranches]) => (
          <Card key={`branches-${repo}`}>
            <CardHeader>
              <CardTitle className="text-base">
                Remote Branches{" "}
                <span className="font-mono font-normal text-muted-foreground">{repo}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Branch</TableHead>
                      <TableHead>Last Commit</TableHead>
                      <TableHead>Pipeline Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {repoBranches.map((branch) => (
                      <TableRow key={branch.name}>
                        <TableCell className="font-mono text-sm">
                          {branch.change ? (
                            <Link
                              to={`/changes/${branch.change.id}`}
                              className="text-foreground hover:underline"
                            >
                              {branch.name}
                            </Link>
                          ) : (
                            branch.name
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {timeAgo(branch.commit.timestamp)}
                        </TableCell>
                        <TableCell>
                          {branch.change ? (
                            <Badge variant={statusVariant(branch.change.status)}>
                              {branch.change.status}
                            </Badge>
                          ) : (
                            <span className="text-sm text-muted-foreground">No activity</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

export function Dashboard() {
  const {
    status,
    me,
    startLoginAttempt,
    pollLoginAttempt,
    redeemLoginGrant,
    refreshSession,
    peekMagicLink,
  } = useAuthSession();
  const lifecycle = getAuthLifecycleState(status, me);

  if (lifecycle !== "active" || !me) {
    return (
      <AuthGate
        me={me}
        lifecycle={lifecycle}
        onRefresh={refreshSession}
        onStartLoginAttempt={startLoginAttempt}
        onPollLoginAttempt={pollLoginAttempt}
        onRedeemLoginGrant={redeemLoginGrant}
        onPeekMagicLink={peekMagicLink}
      />
    );
  }

  return <DashboardContent me={me} />;
}
