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
import {
  fetchVelocity,
  fetchReviewQueue,
  fetchRepos,
  fetchBranches,
  type Change,
  type Velocity,
  type Branch,
} from "@/lib/api";

function timeAgo(dateStr: string): string {
  const normalized = dateStr.includes("T") || dateStr.includes("Z") ? dateStr : dateStr + "Z";
  const seconds = Math.floor((Date.now() - new Date(normalized).getTime()) / 1000);
  if (isNaN(seconds) || seconds < 0) return "just now";
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

  const loadVelocity = useCallback(() => {
    fetchVelocity()
      .then(setVelocity)
      .catch(() => setVelocityError(true));
  }, []);

  const loadBranches = useCallback(() => {
    fetchRepos()
      .then(async (repos) => {
        const result: Record<string, Branch[]> = {};
        await Promise.all(
          repos.map(async (repo) => {
            const repoBranches = await fetchBranches(repo);
            if (repoBranches.length > 0) {
              result[repo] = repoBranches;
            }
          })
        );
        setBranches(result);
        setBranchesLoading(false);
        setBranchesError(false);
      })
      .catch(() => {
        setBranchesLoading(false);
        setBranchesError(true);
      });
  }, []);

  useEffect(() => {
    loadVelocity();
    loadQueue();
    loadBranches();
    const interval = setInterval(() => {
      loadVelocity();
      loadQueue();
      loadBranches();
    }, 3000);
    return () => clearInterval(interval);
  }, [loadQueue, loadVelocity, loadBranches]);

  return (
    <div className="space-y-6">
      {/* Queue cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Summarized (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {velocityError ? (
              <p className="text-3xl font-bold text-muted-foreground">&mdash;</p>
            ) : velocity ? (
              <p className="text-3xl font-bold text-primary">{velocity.summarized}</p>
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

      {/* Review queue — grouped by repo */}
      {queueError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Unable to load review queue.
            </p>
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
          <p className="text-sm text-muted-foreground">
            No changes awaiting review.
          </p>
        </div>
      ) : (
        Object.entries(
          queue.reduce<Record<string, Change[]>>((acc, change) => {
            (acc[change.repo] ??= []).push(change);
            return acc;
          }, {})
        ).map(([repo, changes]) => (
          <Card key={repo}>
            <CardHeader>
              <CardTitle className="text-base">
                Review Queue{" "}
                <span className="font-mono text-muted-foreground font-normal">{repo}</span>
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

      {/* Remote Branches */}
      {branchesError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Unable to load remote branches.
            </p>
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
                <span className="font-mono text-muted-foreground font-normal">{repo}</span>
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
