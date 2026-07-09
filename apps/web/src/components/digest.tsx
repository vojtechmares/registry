import { shortDigest } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";

interface DigestProps {
  value: string;
  length?: number;
}

/**
 * A digest is 71 characters and nobody reads past the first few, but the whole
 * value is what people paste into a `docker pull`. Show the prefix, copy it all.
 */
export function Digest({ value, length }: DigestProps) {
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-xs text-muted-foreground" title={value}>
        {shortDigest(value, length)}
      </code>
      <CopyButton value={value} label="Copy digest" />
    </span>
  );
}
