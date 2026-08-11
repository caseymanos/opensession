import { publicApiScopes } from "@sessionbox-killer/contracts/public-api";

import { publicApiOperations } from "./catalog.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function operationRows(): string {
  return publicApiOperations
    .map(
      (operation) => `<tr>
        <td><span class="method method-${operation.method}">${operation.method.toUpperCase()}</span></td>
        <td><code>${escapeHtml(`/api/v1${operation.openApiPath}`)}</code></td>
        <td>${escapeHtml(operation.summary)}</td>
        <td><code>${escapeHtml(operation.scope)}</code></td>
      </tr>`,
    )
    .join("");
}

export function publicApiDocsHtml(): string {
  const curlExample = `curl --fail-with-body \\
  --header "Authorization: Bearer $OPENSESSION_API_KEY" \\
  "https://opensessionboard.com/api/v1/events?limit=25"`;
  const mutationExample = `curl --fail-with-body --request PATCH \\
  --header "Authorization: Bearer $OPENSESSION_API_KEY" \\
  --header "Content-Type: application/json" \\
  --header "Idempotency-Key: submission-review-2026-08-10" \\
  --header 'If-Match: "opensession-submission-v12"' \\
  --data '{"status":"in_review","reason":"Ready for committee review"}' \\
  "https://opensessionboard.com/api/v1/events/evt_example/submissions/sub_example"`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="OpenSession Public API v1 documentation">
  <title>OpenSession Public API v1</title>
  <style>
    :root { color-scheme: light dark; --ink: #152018; --muted: #526158; --paper: #f5f7f2; --panel: #fff; --line: #d9e0d8; --accent: #176b43; --code: #102319; --code-ink: #d8f4df; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    a { color: var(--accent); text-underline-offset: .18em; }
    a:focus-visible, pre:focus-visible, summary:focus-visible { outline: 3px solid #66c68c; outline-offset: 3px; border-radius: 3px; }
    header { background: #0b2618; color: #f5fff8; }
    .header-inner, main, footer { width: min(1120px, calc(100% - 2rem)); margin-inline: auto; }
    .header-inner { padding: 4.5rem 0 3.5rem; }
    .eyebrow { margin: 0 0 .5rem; color: #a9e3bc; font-size: .78rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1, h2, h3 { line-height: 1.16; letter-spacing: -.025em; }
    h1 { max-width: 760px; margin: 0; font-size: clamp(2.35rem, 7vw, 4.75rem); }
    .lede { max-width: 730px; margin: 1rem 0 1.75rem; color: #d4e8da; font-size: 1.15rem; }
    .header-links { display: flex; flex-wrap: wrap; gap: .75rem; }
    .button { display: inline-flex; min-height: 44px; align-items: center; padding: .55rem .9rem; border: 1px solid #83ba95; border-radius: 999px; color: #f6fff8; font-weight: 750; text-decoration: none; }
    .button-primary { background: #dcfce7; border-color: #dcfce7; color: #0b3a20; }
    main { padding: 2.5rem 0 5rem; }
    section { margin-top: 3.5rem; scroll-margin-top: 1rem; }
    h2 { margin: 0 0 1rem; font-size: clamp(1.75rem, 4vw, 2.55rem); }
    h3 { margin-top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 1rem; }
    .card { padding: 1.25rem; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); box-shadow: 0 10px 35px rgb(20 40 25 / 5%); }
    .card p:last-child { margin-bottom: 0; }
    code { font: .9em/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { overflow-x: auto; margin: 1rem 0 0; padding: 1.1rem; border-radius: 12px; background: var(--code); color: var(--code-ink); line-height: 1.55; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .85rem 1rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    tr:last-child td { border-bottom: 0; }
    th { color: var(--muted); font-size: .76rem; letter-spacing: .07em; text-transform: uppercase; }
    .method { display: inline-block; min-width: 4.2rem; padding: .18rem .45rem; border-radius: 6px; color: #fff; font-size: .72rem; font-weight: 850; text-align: center; }
    .method-get { background: #176b43; }
    .method-patch { background: #855400; }
    .scope-list { display: flex; flex-wrap: wrap; gap: .45rem; padding: 0; list-style: none; }
    .scope-list code { display: block; padding: .26rem .5rem; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); }
    .callout { border-left: 5px solid #c47700; }
    footer { padding: 2rem 0 3rem; color: var(--muted); }
    @media (prefers-color-scheme: dark) { :root { --ink: #edf8f0; --muted: #b4c1b8; --paper: #09120d; --panel: #101d15; --line: #2a3a30; --accent: #7ee2a3; --code: #030906; } header { background: #06170d; } }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <p class="eyebrow">Stable public interface</p>
      <h1>OpenSession Public API v1</h1>
      <p class="lede">A provider-neutral, scope-aware API for event operations. Runtime validation and this OpenAPI description are generated from the same schemas used by the Worker.</p>
      <nav class="header-links" aria-label="API documentation">
        <a class="button button-primary" href="/openapi.json">OpenAPI 3.1 JSON</a>
        <a class="button" href="#endpoints">Browse endpoints</a>
        <a class="button" href="#authentication">Authentication</a>
      </nav>
    </div>
  </header>
  <main>
    <section aria-labelledby="principles-heading">
      <h2 id="principles-heading">Designed for safe automation</h2>
      <div class="grid">
        <article class="card"><h3>Scoped credentials</h3><p>Each key belongs to one organization and can be restricted to one event and an explicit set of capabilities.</p></article>
        <article class="card"><h3>Predictable collections</h3><p>Collections use opaque cursor pagination with a default page size of 25 and a maximum of 100.</p></article>
        <article class="card"><h3>Safe mutations</h3><p>Every mutation requires both <code>Idempotency-Key</code> and the latest strong <code>If-Match</code> entity tag.</p></article>
      </div>
    </section>

    <section id="authentication" aria-labelledby="authentication-heading">
      <h2 id="authentication-heading">Authentication</h2>
      <p>Create a key in <strong>Workspace → Integrations → API access</strong>. Plaintext is never recoverable after creation. OpenSession displays it once and stores only a salted, peppered one-way verifier.</p>
      <div class="card callout"><strong>Treat keys like passwords.</strong> Keep them out of source code, browser bundles, URLs, screenshots, logs, and support tickets. Revoke a key immediately if it may have been exposed.</div>
      <pre aria-label="Authentication curl example" tabindex="0"><code>${escapeHtml(curlExample)}</code></pre>
      <h3>Available scopes</h3>
      <ul class="scope-list">${publicApiScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")}</ul>
    </section>

    <section id="endpoints" aria-labelledby="endpoints-heading">
      <h2 id="endpoints-heading">Endpoints</h2>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Public API endpoints">
        <table>
          <thead><tr><th>Method</th><th>Path</th><th>Purpose</th><th>Required scope</th></tr></thead>
          <tbody>${operationRows()}</tbody>
        </table>
      </div>
    </section>

    <section aria-labelledby="pagination-heading">
      <h2 id="pagination-heading">Pagination and limits</h2>
      <div class="grid">
        <article class="card"><h3>Cursors</h3><p>Send <code>?limit=25</code>. When <code>page.next_cursor</code> is non-null, pass it unchanged as <code>?cursor=…</code>. A cursor is bound to its resource and credential scope.</p></article>
        <article class="card"><h3>Rate limits</h3><p>Reads allow 120 requests per key per minute; writes allow 30. Inspect <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code>, and <code>RateLimit-Reset</code>. A <code>429</code> also includes <code>Retry-After</code>.</p></article>
      </div>
    </section>

    <section aria-labelledby="mutations-heading">
      <h2 id="mutations-heading">Conditional, idempotent mutations</h2>
      <p>Read the singular resource first, retain its <code>ETag</code>, and send that exact value in <code>If-Match</code>. Reuse an idempotency key only when retrying the identical request.</p>
      <pre aria-label="Conditional mutation curl example" tabindex="0"><code>${escapeHtml(mutationExample)}</code></pre>
    </section>

    <section aria-labelledby="errors-heading">
      <h2 id="errors-heading">Errors and request IDs</h2>
      <p>Errors use <code>application/problem+json</code> and include <code>type</code>, <code>title</code>, <code>status</code>, <code>detail</code>, a stable <code>code</code>, and <code>request_id</code>. The same identifier is returned in <code>X-Request-Id</code>; include it when requesting support.</p>
      <pre aria-label="Problem response example" tabindex="0"><code>{
  "type": "https://opensessionboard.com/problems/event_scope_mismatch",
  "title": "Event scope mismatch",
  "status": 403,
  "detail": "This API key cannot access the requested event.",
  "code": "event_scope_mismatch",
  "request_id": "req_example123"
}</code></pre>
    </section>
  </main>
  <footer>OpenSession Public API v1 · <a href="/openapi.json">Machine-readable schema</a></footer>
</body>
</html>`;
}
