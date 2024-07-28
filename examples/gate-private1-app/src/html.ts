// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export interface RenderHomePageOptions {
    apiPath: string;
    assetPath: string;
    basePath: string;
    email: string;
    eventPath: string;
    sessionPath: string;
    websocketPath: string;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function renderHomePage(options: RenderHomePageOptions): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Magic Link SSO private1</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        background: linear-gradient(160deg, #eff7f0 0%, #f8f5ed 100%);
        color: #10251a;
      }

      main {
        max-width: 68rem;
        margin: 0 auto;
        padding: 3rem 1.25rem 4rem;
      }

      .hero {
        background: rgba(255, 255, 255, 0.9);
        border: 1px solid rgba(16, 37, 26, 0.12);
        border-radius: 1.5rem;
        padding: 2rem;
        box-shadow: 0 1.25rem 4rem rgba(16, 37, 26, 0.08);
      }

      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 0.75rem;
        color: #50725c;
        margin: 0 0 0.75rem;
      }

      h1 {
        margin: 0 0 0.75rem;
        font-size: clamp(2rem, 4vw, 3.5rem);
        line-height: 1.05;
      }

      .copy {
        max-width: 44rem;
        font-size: 1.05rem;
        line-height: 1.6;
        color: #2c4a37;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
        gap: 1rem;
        margin-top: 1.75rem;
      }

      .panel {
        background: #10251a;
        color: #f4f7f2;
        border-radius: 1.25rem;
        padding: 1.25rem;
      }

      .panel h2 {
        margin: 0 0 0.5rem;
        font-size: 1rem;
      }

      .mono {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        word-break: break-word;
      }

      .toolbar {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-top: 1rem;
      }

      button,
      a {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 0.8rem 1rem;
        background: #d4622b;
        color: #fff;
        font: inherit;
        text-decoration: none;
        cursor: pointer;
      }

      button.secondary,
      a.secondary {
        background: #254734;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">Magic Link SSO Gate</p>
        <h1>Your private1 session is locked in and proxied.</h1>
        <p class="copy">
          This page comes from the upstream app. The upstream only sees the forwarded
          identity headers from Gate and never handles the sign-in flow itself.
        </p>
        <div class="grid">
          <section class="panel">
            <h2>Forwarded Email</h2>
            <p id="forwarded-email" class="mono">${escapeHtml(options.email)}</p>
            <form action="${escapeHtml(options.basePath)}/_magicgate/logout" method="post">
              <div class="toolbar">
                <button type="submit">Logout</button>
                <a class="secondary" href="${escapeHtml(options.basePath)}/_magicgate/session">Open Session JSON</a>
              </div>
            </form>
          </section>
          <section class="panel">
            <h2>Live Endpoints</h2>
            <pre id="api-result">Loading API result…</pre>
            <div class="toolbar">
              <a href="${escapeHtml(options.assetPath)}">Open asset</a>
              <a class="secondary" href="${escapeHtml(options.eventPath)}">Open SSE stream</a>
            </div>
          </section>
        </div>
      </section>
    </main>
    <script type="module" src="${escapeHtml(options.assetPath)}"></script>
    <script type="module">
      const apiPath = ${JSON.stringify(options.apiPath)};
      const sessionPath = ${JSON.stringify(options.sessionPath)};
      const websocketPath = ${JSON.stringify(options.websocketPath)};

      const apiResult = document.querySelector('#api-result');

      async function readJson(url) {
        const response = await fetch(url, {
          headers: {
            accept: 'application/json'
          }
        });
        return response.json();
      }

      Promise.all([readJson(apiPath), readJson(sessionPath)])
        .then(([apiPayload, sessionPayload]) => {
          const websocketUrl = new URL(websocketPath, window.location.origin);
          websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
          apiResult.textContent = JSON.stringify(
            {
              apiPayload,
              sessionPayload,
              websocketUrl: websocketUrl.toString()
            },
            null,
            2
          );
        })
        .catch((error) => {
          apiResult.textContent = String(error);
        });
    </script>
  </body>
</html>`;
}
