// Enterprise data auth manager ("Acme Data"): a wizard. Flow = the plugin replaces the
// view; the host keeps nodes with the same key mounted (focus, scroll).
window.PLUGINS = window.PLUGINS || {};

(() => {
  const hdr = (pill) => ({ icon: 'database', title: 'Acme Data access', pill, sub: [
    { type: 'text', text: 'Per user' },
    { type: 'text', text: 'applies to new sessions' },
  ] });

  const signedOut = {
    header: hdr({ label: 'Signed out', status: 'neutral' }),
    body: [
      { type: 'markdown', key: 'intro', source: 'Sign in once and every new Claude session in the projects you pick can query Acme Data: it gets the `acme-data` MCP server and the **Acme Data** skill, with a token that renews itself.\n\nYou finish signing in in your browser.' },
      { type: 'actions', key: 'acts', items: [{ type: 'button', key: 'signin', label: 'Sign in with browser', icon: 'log-in', variant: 'default', action: 'signin.start' }] },
      { type: 'text', key: 'help', tone: 'muted', text: 'Uses your Okta account. No access yet? Ask in #data-access.' },
    ],
  };

  const waiting = {
    header: hdr({ label: 'Waiting', status: 'running' }),
    body: [
      { type: 'text', key: 'lead', text: 'Your browser opened login.acme.com. Enter this code there:' },
      { type: 'code', key: 'code', value: 'WDJB-MJHT', copy: true, action: 'code.copy' },
      { type: 'spinner', key: 'wait', label: 'Waiting for you to approve', meta: { type: 'time', at: '2026-10-14T23:10:00Z', format: 'countdown', display: 'code expires in 9:41' } },
      { type: 'actions', key: 'acts', items: [
        { type: 'button', key: 'reopen', label: 'Open the page again', icon: 'external-link', variant: 'muted', action: 'signin.reopen' },
        { type: 'button', key: 'cancel', label: 'Cancel', icon: 'x', variant: 'muted', action: 'signin.cancel' },
      ] },
    ],
  };

  const choose = {
    header: hdr({ label: 'Choose account', status: 'neutral' }),
    body: [
      { type: 'text', key: 'lead', text: 'Signed in as alex.w@acme.com. Pick what sessions read from.' },
      { type: 'form', key: 'setup', action: 'setup.submit', children: [
        { type: 'select', key: 'account', label: 'Account', value: 'alex.w@acme.com · Analytics', options: ['alex.w@acme.com · Analytics', 'svc-analytics · team service account'] },
        { type: 'select', key: 'env', label: 'Environment', value: 'Production · read-only', options: ['Production · read-only', 'Staging', 'Sandbox'], hint: 'Your role can only read Production.' },
        { type: 'section', key: 'projects', title: 'Use in new sessions of', children: [
          { type: 'checkbox', key: 'p-cf', label: 'code-foundry', checked: true },
          { type: 'checkbox', key: 'p-dp', label: 'data-pipelines', checked: true },
          { type: 'checkbox', key: 'p-web', label: 'website', checked: false },
          { type: 'checkbox', key: 'p-none', label: 'Threads with no project', checked: false },
        ] },
      ],
      submit: { type: 'button', key: 'go', label: 'Continue', variant: 'default', action: 'setup.submit' },
      cancel: { type: 'button', key: 'back', label: 'Sign out', variant: 'muted', action: 'signout' } },
    ],
  };

  const configuring = {
    header: hdr({ label: 'Setting up', status: 'running' }),
    body: [
      { type: 'progress', key: 'p', value: 0.6, label: 'Setting up Production · read-only', meta: '3 of 5' },
      { type: 'list', key: 'steps', items: [
        { key: 's1', status: 'ok', title: 'Signed in as alex.w@acme.com' },
        { key: 's2', status: 'ok', title: 'Got a Production token', meta: 'read-only' },
        { key: 's3', status: 'ok', title: 'Added the acme-data MCP server' },
        { key: 's4', status: 'running', title: 'Installing the Acme Data skill' },
        { key: 's5', status: 'pending', title: 'Running a test query' },
      ] },
      { type: 'actions', key: 'acts', items: [{ type: 'button', key: 'cancel', label: 'Cancel', icon: 'x', variant: 'muted', action: 'setup.cancel' }] },
    ],
  };

  const signedIn = {
    header: hdr({ label: 'Signed in', status: 'ok' }),
    body: [
      { type: 'fields', key: 'who', items: [
        { key: 'Account', value: 'alex.w@acme.com' },
        { key: 'Environment', value: 'Production · read-only' },
        { key: 'Token expires', value: { type: 'time', at: '2026-10-15T06:58:00Z', format: 'relative', display: 'in 7 h 52 min, renews itself' } },
        { key: 'Projects', value: 'code-foundry, data-pipelines' },
      ] },
      { type: 'actions', key: 'acts', items: [
        { type: 'button', key: 'refresh', label: 'Refresh', icon: 'refresh-cw', variant: 'muted', action: 'token.refresh' },
        { type: 'button', key: 'change', label: 'Change', icon: 'pencil', variant: 'muted', action: 'setup.change' },
        { type: 'button', key: 'signout', label: 'Sign out', icon: 'log-out', variant: 'destructive', action: 'signout', confirm: 'Sign out of Acme Data? New sessions lose access.' },
      ] },
      { type: 'section', key: 'inject', title: 'Added to new sessions', children: [
        { type: 'fields', key: 'env', items: [
          { key: 'ACME_DATA_ENV', keyMono: true, value: 'prod', mono: true },
          { key: 'ACME_DATA_TOKEN', keyMono: true, value: '••••••••••••', mono: true, secret: true },
          { key: 'MCP server', value: 'acme-data · http', mono: true },
          { key: 'Skill', value: 'acme-data', mono: true },
        ] },
        { type: 'text', key: 'note', tone: 'muted', text: 'Sessions already running keep their token until they reconnect.' },
      ] },
    ],
  };

  const error = {
    header: hdr({ label: 'Failed', status: 'error' }),
    body: [
      { type: 'notice', key: 'err', tone: 'error', icon: 'circle-alert', title: 'Sign-in failed',
        text: [{ type: 'text', text: 'login.acme.com refused the token exchange: alex.w@acme.com is not in the data-readers group.' }, { type: 'text', mono: true, text: '403 access_denied' }],
        actions: [
          { type: 'button', key: 'retry', label: 'Try again', icon: 'refresh-cw', variant: 'attention', action: 'signin.start' },
          { type: 'button', key: 'copy', label: 'Copy details', icon: 'copy', variant: 'muted', action: 'error.copy' },
        ] },
      { type: 'markdown', key: 'help', source: 'Ask for the **data-readers** group in [#data-access](https://chat.acme.com/data-access), then try again.' },
    ],
  };

  PLUGINS.auth = {
    surface: { id: 'acme-data.auth', plugin: 'acme-data', title: 'Data access', icon: 'database' },
    tabsBefore: [{ title: 'MCP', icon: 'plug' }],
    thread: {
      ask: 'Pull last week\'s churn numbers from the warehouse and chart them by plan.',
      tools: [['search', 'Searched tools for <b>acme-data</b>']],
      answer: 'This session has no <code>acme-data</code> MCP server, so I can\'t reach the warehouse. Sign in from the Data access tab and start a new thread; new sessions pick it up.',
    },
    states: { 'signed-out': signedOut, waiting, choose, configuring, 'signed-in': signedIn, error },
  };
})();
