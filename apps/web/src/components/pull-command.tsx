import { pullCommand } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";

interface PullCommandProps {
  repository: string;
  reference: string;
  host?: string;
}

/** The one thing a visitor to a public repository actually came for. */
export function PullCommand({ repository, reference, host }: PullCommandProps) {
  const command = pullCommand(repository, reference, host ?? window.location.host);

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">{command}</code>
      <CopyButton value={command} label="Copy pull command" />
    </div>
  );
}
