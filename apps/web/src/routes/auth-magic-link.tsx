import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { completeMagicLink } from "@/lib/api";

function parseMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function MagicLinkPage() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Completing your sign-in link.");

  useEffect(() => {
    const attemptId = searchParams.get("attempt_id")?.trim();
    const token = searchParams.get("token")?.trim();
    const clientId = searchParams.get("client_id")?.trim() ?? "red-web";

    if (!attemptId || !token) {
      setStatus("error");
      setMessage("The magic link is missing required parameters.");
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        await completeMagicLink({
          attemptId,
          token,
          clientId,
        });
        if (cancelled) return;
        setStatus("success");
        setMessage("Magic link confirmed. Return to the original login page to finish signing in.");
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setMessage(parseMessage(error, "Unable to complete the magic link."));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-2xl items-center">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-2xl">Magic link sign-in</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant={status === "error" ? "destructive" : "default"}>
            <AlertTitle>
              {status === "loading"
                ? "Working"
                : status === "success"
                  ? "Complete"
                  : "Unable to complete sign-in"}
            </AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
