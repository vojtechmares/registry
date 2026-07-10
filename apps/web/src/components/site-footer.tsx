import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, BoxIcon } from "lucide-react";
import { CopyButton } from "@/components/copy-button";

/** Styled like a terminal section marker, to match the ascii banner upstairs. */
function FooterHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">{children}</h3>;
}

function FooterExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      {children}
      <ArrowUpRightIcon className="size-3 opacity-50 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

const footerLinkClass = "text-sm text-muted-foreground transition-colors hover:text-foreground";

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto w-full max-w-6xl px-4">
        <div className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[1.2fr_0.8fr_0.8fr_1.2fr]">
          <div>
            <Link to="/" className="inline-flex items-center gap-2 font-semibold">
              <BoxIcon className="size-5" />
              <span>registry</span>
            </Link>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              A serverless OCI registry on Cloudflare.
            </p>
            <dl className="mt-6 space-y-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Endpoint</dt>
                <dd className="mt-0.5">
                  <code className="font-mono">/v2/</code>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Conformance</dt>
                <dd className="mt-0.5">
                  <code className="font-mono">OCI distribution-spec</code>
                </dd>
              </div>
            </dl>
          </div>

          <nav aria-label="Registry">
            <FooterHeading>Registry</FooterHeading>
            <ul className="mt-4 space-y-2.5">
              <li>
                <Link to="/" className={footerLinkClass}>
                  Repositories
                </Link>
              </li>
              <li>
                <Link to="/projects" className={footerLinkClass}>
                  Projects
                </Link>
              </li>
              <li>
                <Link to="/settings/tokens" className={footerLinkClass}>
                  Tokens
                </Link>
              </li>
              <li>
                <Link to="/login" className={footerLinkClass}>
                  Sign in
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="Resources">
            <FooterHeading>Resources</FooterHeading>
            <ul className="mt-4 space-y-2.5">
              <li>
                {/* Swagger UI is served by the API, outside the router. */}
                <a href="/api/v1/docs" className={footerLinkClass}>
                  API reference
                </a>
              </li>
              <li>
                <FooterExternalLink href="https://github.com/opencontainers/distribution-spec">
                  OCI distribution spec
                </FooterExternalLink>
              </li>
              <li>
                <FooterExternalLink href="https://workers.cloudflare.com">
                  Cloudflare Workers
                </FooterExternalLink>
              </li>
              <li>
                <FooterExternalLink href="https://github.com/cloudflare/serverless-registry">
                  cloudflare/serverless-registry
                </FooterExternalLink>
              </li>
            </ul>
          </nav>

          <div>
            <FooterHeading>Push an image</FooterHeading>
            <p className="mt-4 text-sm text-muted-foreground">
              Authenticate with a token, then push and pull from your terminal as usual.
            </p>
            <LoginCommand />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 border-t py-6 md:flex-row md:justify-between">
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} registry. Built on Cloudflare Workers.
          </p>
          <span aria-hidden="true" className="font-mono text-xs text-muted-foreground/60 select-none">
            ~ eof
          </span>
        </div>
      </div>
    </footer>
  );
}

/** Mirrors PullCommand: the host comes from the page, so any deployment prints itself. */
function LoginCommand() {
  const command = `docker login ${window.location.host}`;

  return (
    <div className="mt-4 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">{command}</code>
      <CopyButton value={command} label="Copy login command" />
    </div>
  );
}
