import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginWithTotp } from "@/lib/api";
import { useAuthSession } from "@/lib/auth";

function parseApiMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function AuthYubikeyPage() {
  const navigate = useNavigate();
  const { refreshSession } = useAuthSession();
  const [email, setEmail] = useState("douglasjbinder@gmail.com");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("working");
    setMessage(null);
    try {
      await loginWithTotp(email.trim().toLowerCase(), code.trim());
      await refreshSession();
      navigate("/", { replace: true });
    } catch (error) {
      setStatus("error");
      setMessage(parseApiMessage(error, "Unable to sign in with YubiKey TOTP."));
    } finally {
      setStatus((current) => (current === "error" ? "error" : "idle"));
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl items-center">
      <Card className="w-full border-primary/20 bg-gradient-to-br from-primary/10 via-card to-background">
        <CardHeader>
          <CardTitle className="text-2xl">YubiKey Login</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="yubikey-email">Email</Label>
              <Input
                id="yubikey-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="yubikey-code">YubiKey TOTP code</Label>
              <Input
                id="yubikey-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={status === "working"}>
              {status === "working" ? "Signing in..." : "Sign in with YubiKey"}
            </Button>
          </form>
          {message && (
            <Alert variant="destructive" className="mt-4">
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
