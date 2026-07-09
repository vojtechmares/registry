import { Link } from "@tanstack/react-router";
import type { RepositorySummary } from "@registry/api-contract";
import { Badge } from "@workspace/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { formatBytes, formatRelativeTime } from "@/lib/format";

interface RepositoryTableProps {
  repositories: readonly RepositorySummary[];
}

export function RepositoryTable({ repositories }: RepositoryTableProps) {
  if (repositories.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        No repositories yet. Push an image to create one.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead className="w-24">Visibility</TableHead>
          <TableHead className="w-20 text-right">Tags</TableHead>
          <TableHead className="w-24 text-right">Size</TableHead>
          <TableHead className="w-36 text-right">Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {repositories.map((repository) => (
          <TableRow key={repository.name}>
            <TableCell>
              <Link
                to="/r/$"
                params={{ _splat: repository.name }}
                className="font-medium underline-offset-4 hover:underline"
              >
                {repository.name}
              </Link>
            </TableCell>
            <TableCell>
              <Badge variant={repository.visibility === "public" ? "secondary" : "outline"}>
                {repository.visibility}
              </Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">{repository.tags}</TableCell>
            <TableCell className="text-right tabular-nums">{formatBytes(repository.sizeBytes)}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              {formatRelativeTime(repository.updatedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
