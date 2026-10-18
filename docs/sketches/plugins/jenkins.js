// Jenkins pipeline tracker: the view models the plugin pushes, one per state.
// Every node is { type, key?, ...props }; interactive nodes carry an `action` id the host
// sends back as {action, payload}. `display` on time nodes is mock-only: the host formats
// and ticks `at` itself, so the plugin does not push a view every second.
window.PLUGINS = window.PLUGINS || {};

(() => {
  const BUILD = 'https://jenkins.corp.example.com/job/code-foundry/job/PR-63/412/';
  const openLink = { type: 'link', key: 'open', label: 'Open in Jenkins', href: BUILD, icon: 'external-link' };
  const hdr = (pill, sub) => ({ icon: 'workflow', title: '#63 Fix stale PR badge', pill, sub });

  // Stage chips: the same status vocabulary as pills and list leads.
  const stages = (over = {}) => ({
    type: 'chips', key: 'stages', items: [
      { key: 'checkout', label: 'Checkout', status: 'ok', meta: '12s' },
      { key: 'build', label: 'Build', status: 'ok', meta: '1m 48s' },
      { key: 'unit', label: 'Unit tests', status: 'ok', meta: '2m 03s' },
      { key: 'integration', label: 'Integration', status: 'ok', meta: '1m 37s' },
      { key: 'deploy', label: 'Deploy staging', status: 'ok', meta: '1m 21s' },
      { key: 'smoke', label: 'Smoke tests', status: 'ok', meta: '40s' },
    ].map((s) => ({ ...s, ...(over[s.key] || {}) })),
  });

  const commit = [
    { key: 'Commit', value: 'a3f9c21', mono: true, copy: true, action: 'copy.sha' },
    { key: 'Branch', value: 'cf/pr-badge-stale', mono: true },
  ];

  const running = {
    header: hdr({ label: 'Running', status: 'running' }, [
      { type: 'text', text: 'Build #412' },
      { type: 'time', at: '2026-10-14T22:37:00Z', format: 'elapsed', display: '4m 12s' },
      openLink,
    ]),
    body: [
      stages({ integration: { status: 'running', meta: '22s' }, deploy: { status: 'pending', meta: '' }, smoke: { status: 'pending', meta: '' } }),
      { type: 'actions', key: 'acts', items: [{ type: 'button', key: 'abort', label: 'Abort', icon: 'circle-stop', variant: 'destructive', action: 'build.abort', confirm: 'Abort build #412?' }] },
      { type: 'log', key: 'log', title: 'Integration', meta: 'live', follow: true, copy: true, action: 'log.copy', lines: [
        { text: '> go test -tags integration ./internal/...' },
        { text: '=== RUN   TestStoreSnapshots' },
        { text: '--- PASS: TestStoreSnapshots (0.84s)' },
        { text: '=== RUN   TestGhPollerBatchesViewerQuery' },
        { text: '--- PASS: TestGhPollerBatchesViewerQuery (2.10s)' },
        { text: '=== RUN   TestPrBadgeRefreshAfterForcePush' },
        { text: '    badge_test.go:88: waiting for checks fingerprint to change' },
      ] },
      { type: 'fields', key: 'meta', items: [...commit, { key: 'Started by', value: 'push from alex.w' }] },
    ],
  };

  const failed = {
    header: hdr({ label: 'Failed', status: 'error' }, [
      { type: 'text', text: 'Build #412' },
      { type: 'time', at: '2026-10-14T22:37:00Z', format: 'duration', display: 'failed after 6m 58s' },
      openLink,
    ]),
    body: [
      stages({ deploy: { status: 'error', meta: '1m 21s' }, smoke: { status: 'skipped', meta: '' } }),
      { type: 'actions', key: 'acts', items: [
        { type: 'button', key: 'send', label: 'Send failure to Claude', icon: 'send', variant: 'attention', action: 'failure.send' },
        { type: 'button', key: 'rebuild', label: 'Rebuild', icon: 'rotate-ccw', variant: 'muted', action: 'build.rebuild' },
      ] },
      { type: 'log', key: 'log', title: 'Deploy staging', meta: 'last 40 lines', copy: true, action: 'log.copy', lines: [
        { text: '+ helm upgrade --install pr-badge ./chart -n staging --wait --timeout 5m' },
        { text: 'Release "pr-badge" does not exist. Installing it now.' },
        { text: 'W1014 22:41:07 warnings.go:70] resources: limits not set', tone: 'attention' },
        { text: 'Error: INSTALLATION FAILED: timed out waiting for the condition', tone: 'error' },
        { text: '  pod/pr-badge-6c9f7d5b8-xk2lp: Back-off pulling image "registry.corp/pr-badge:a3f9c21"', tone: 'error' },
        { text: '  pod/pr-badge-6c9f7d5b8-xk2lp: manifest unknown', tone: 'error' },
        { text: 'script returned exit code 1' },
      ] },
      { type: 'fields', key: 'meta', items: [...commit, { key: 'Started by', value: 'push from alex.w' }] },
    ],
    // Contribution 4: the plugin raised the thread; the host shows it in the sidebar row.
    attention: 'Jenkins: deploy stage failed',
  };

  const succeeded = {
    header: hdr({ label: 'Passed', status: 'ok' }, [
      { type: 'text', text: 'Build #412' },
      { type: 'time', at: '2026-10-14T22:44:41Z', format: 'relative', display: 'finished 12 min ago' },
      openLink,
    ]),
    body: [
      stages(),
      { type: 'actions', key: 'acts', items: [{ type: 'button', key: 'rebuild', label: 'Rebuild', icon: 'rotate-ccw', variant: 'muted', action: 'build.rebuild' }] },
      { type: 'fields', key: 'meta', items: [
        { key: 'Duration', value: '7m 41s' },
        { key: 'Tests', value: '1,284 passed · 12 skipped' },
        ...commit,
      ] },
      { type: 'section', key: 'log', title: 'Log', collapsible: true, open: false, action: 'section.toggle', children: [] },
    ],
  };

  const queued = {
    header: hdr({ label: 'Queued', status: 'neutral' }, [
      { type: 'text', text: 'Build #413' },
      { type: 'time', at: '2026-10-14T22:55:20Z', format: 'elapsed', display: 'queued 1m 40s' },
      openLink,
    ]),
    body: [
      { type: 'empty', key: 'empty', icon: 'hourglass', title: 'Waiting for an executor', text: '2 builds ahead on linux-large. Stages show once the build starts.',
        actions: [{ type: 'button', key: 'cancel', label: 'Cancel build', icon: 'x', variant: 'muted', action: 'build.cancel' }] },
      { type: 'section', key: 'prev', title: 'Earlier builds', children: [
        { type: 'list', key: 'builds', items: [
          { key: '412', status: 'error', title: '#412 · Deploy staging failed', meta: '38 min ago', action: 'build.open' },
          { key: '411', status: 'ok', title: '#411 · Passed', meta: '2 h ago', action: 'build.open' },
          { key: '410', status: 'skipped', title: '#410 · Aborted', meta: 'yesterday', action: 'build.open' },
        ] },
      ] },
    ],
  };

  const unreachable = {
    header: hdr({ label: 'Unreachable', status: 'error' }, [
      { type: 'text', text: 'jenkins.corp.example.com' },
      { type: 'time', at: '2026-10-14T22:56:40Z', format: 'relative', display: 'checked 20s ago' },
    ]),
    body: [
      { type: 'notice', key: 'down', tone: 'error', icon: 'server-off', title: "Can't reach Jenkins",
        text: [{ type: 'text', mono: true, text: 'connect ETIMEDOUT 10.40.2.18:443' }, { type: 'text', text: 'Retrying every 30s. Is the VPN on?' }],
        actions: [{ type: 'button', key: 'retry', label: 'Retrying', icon: 'refresh-cw', variant: 'attention', loading: true, action: 'conn.retry' }] },
      { type: 'section', key: 'last', title: 'Last seen 6 min ago', stale: true, children: [
        stages({ integration: { status: 'running', meta: '' }, deploy: { status: 'pending', meta: '' }, smoke: { status: 'pending', meta: '' } }),
        { type: 'fields', key: 'meta', items: [{ key: 'Build', value: '#412 · running' }, ...commit] },
      ] },
    ],
  };

  const needsAuth = {
    header: hdr({ label: 'Needs token', status: 'attention' }, [
      { type: 'text', text: 'jenkins.corp.example.com' },
      openLink,
    ]),
    body: [
      { type: 'notice', key: 'auth', tone: 'attention', icon: 'key-round', title: 'Jenkins needs an API token',
        text: [{ type: 'text', text: 'It answered 401 to the build lookup. The token stays in your macOS keychain.' }] },
      { type: 'form', key: 'token', action: 'auth.save', children: [
        { type: 'input', key: 'user', label: 'User', value: 'alex.w' },
        { type: 'secret', key: 'token', label: 'API token', value: '11d4e6f0a9c2b7', error: 'Jenkins rejected this token (401). Tokens are per user; check the user above.' },
        { type: 'link', key: 'mk', label: 'Create a token in Jenkins', href: 'https://jenkins.corp.example.com/me/configure', icon: 'external-link' },
      ], submit: { type: 'button', key: 'save', label: 'Save and connect', variant: 'default', action: 'auth.save' } },
    ],
  };

  PLUGINS.jenkins = {
    // What the manifest + initialize handshake declare for the surface.
    surface: { id: 'jenkins.pipeline', plugin: 'jenkins', title: 'Jenkins', icon: 'workflow' },
    tabsBefore: [{ title: 'Usage', icon: 'chart-column' }],
    thread: {
      ask: 'Push the badge fix and keep an eye on the Jenkins build for PR #63.',
      tools: [['git-branch', 'Ran <b>git push</b> <span class="mono">origin cf/pr-badge-stale</span>']],
      answer: 'Pushed <code>a3f9c21</code> to <code>cf/pr-badge-stale</code>. Jenkins picked it up as build #412; the Jenkins tab follows it.',
    },
    states: { running, failed, succeeded, queued, unreachable, 'needs-auth': needsAuth },
  };
})();
