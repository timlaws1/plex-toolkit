export function layout({ title, body, flash, user, nav }) {
  const flashHtml = flash
    ? `<div class="flash flash-${escapeHtml(flash.type)}">${escapeHtml(flash.message)}</div>`
    : '';
  const navHtml = user
    ? `<nav class="nav">
        <a href="/" class="${nav === 'dashboard' ? 'active' : ''}">Dashboard</a>
        <a href="/plex" class="${nav === 'plex' ? 'active' : ''}">Plex</a>
        <a href="/plugins" class="${nav === 'plugins' ? 'active' : ''}">Plugins</a>
        <a href="/repository" class="${nav === 'repository' ? 'active' : ''}">Repository</a>
        <form class="logout" method="post" action="/logout"><button type="submit">Log out</button></form>
      </nav>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Plex Toolkit</title>
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>
  <header class="top">
    <div class="brand"><a href="/">Plex Toolkit</a></div>
    ${navHtml}
  </header>
  <main class="container">
    ${flashHtml}
    ${body}
  </main>
</body>
</html>`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function checkbox(name, checked) {
  return `<input type="checkbox" name="${escapeHtml(name)}" value="1" ${checked ? 'checked' : ''} />`;
}
