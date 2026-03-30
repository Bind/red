import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchVelocity, fetchReviewQueue, type Change, type Velocity } from "@/lib/api";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
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
    case "merged":
    case "approved":
      return "default";
    case "rejected":
    case "closed":
      return "destructive";
    case "ready_for_review":
    case "scoring":
    case "summarizing":
      return "secondary";
    default:
      return "outline";
  }
}

function confidenceVariant(confidence: string | null): "default" | "secondary" | "destructive" | "outline" {
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

export function Dashboard() {
  const [velocity, setVelocity] = useState<Velocity | null>(null);
  const [velocityError, setVelocityError] = useState(false);
  const [queue, setQueue] = useState<Change[] | null>(null);
  const [queueError, setQueueError] = useState(false);

  const loadQueue = useCallback(() => {
    fetchReviewQueue()
      .then((data) => {
        setQueue(data);
        setQueueError(false);
      })
      .catch(() => setQueueError(true));
  }, []);

  useEffect(() => {
    fetchVelocity()
      .then(setVelocity)
      .catch(() => setVelocityError(true));
    loadQueue();
    const interval = setInterval(loadQueue, 30000);
    return () => clearInterval(interval);
  }, [loadQueue]);

  return (
    <div className="space-y-6">
      {/* Velocity cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Merged (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {velocityError ? (
              <p className="text-3xl font-bold text-muted-foreground">&mdash;</p>
            ) : velocity ? (
              <p className="text-3xl font-bold text-primary">{velocity.merged}</p>
            ) : (
              <Skeleton className="h-9 w-16" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pending Review
            </CardTitle>
          </CardHeader>
          <CardContent>
            {velocityError ? (
              <p className="text-3xl font-bold text-muted-foreground">&mdash;</p>
            ) : velocity ? (
              <p className="text-3xl font-bold text-primary">{velocity.pending_review}</p>
            ) : (
              <Skeleton className="h-9 w-16" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Review queue */}
      <Card>
        <CardHeader>
          <CardTitle>Review Queue</CardTitle>
        </CardHeader>
        <CardContent>
          {queueError ? (
            <p className="text-sm text-muted-foreground">
              Unable to load review queue.
            </p>
          ) : queue === null ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : queue.length === 0 ? (
            <div className="py-4 text-center">
              <p className="text-sm text-muted-foreground">
                No changes awaiting review.
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                The sea is calm.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repo</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((change) => (
                    <TableRow key={change.id}>
                      <TableCell>
                        <Link
                          to={`/changes/${change.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {change.repo}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{change.branch}</TableCell>
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
