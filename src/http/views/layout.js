export function layout({ title, body, flash, user, nav }) {
  const flashHtml = flash
    ? `<div class="flash flash-${escapeHtml(flash.type)}">${escapeHtml(flash.message)}</div>`
    : '';

  const links = [
    { href: '/', id: 'dashboard', label: 'Home' },
    { href: '/plex', id: 'plex', label: 'Plex' },
    { href: '/plugins', id: 'plugins', label: 'Tools' },
  ];

  const navLinks = links
    .map(
      (item) =>
        `<a href="${item.href}" class="${nav === item.id ? 'active' : ''}">${item.label}</a>`,
    )
    .join('');

  const sidebar = user
    ? `<aside class="shell-sidebar">
        <div class="shell-brand">
          <div class="shell-brand-mark">P</div>
          <div>
            <div class="shell-brand-title">Plex Toolkit</div>
            <div class="shell-brand-sub">Self-hosted tools</div>
          </div>
        </div>
        <nav class="shell-nav">${navLinks}</nav>
        <div class="shell-footer">
          <form method="post" action="/logout">
            <button type="submit" class="ghost" style="width:100%">Log out</button>
          </form>
        </div>
      </aside>
      <header class="shell-mobile">
        <div class="shell-brand-title">Plex Toolkit</div>
        <nav class="shell-mobile-nav">${navLinks}</nav>
      </header>`
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
  <div class="shell">
    ${sidebar}
    <div class="shell-main">
      <main class="shell-content">
        ${flashHtml}
        ${body}
      </main>
    </div>
  </div>
</body>
</html>`;
}

export function pageHeader(title, subtitle) {
  return `<div class="page-header">
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
  </div>`;
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

/**
 * Render settingsSchema fields grouped by `section`, with `advanced: true`
 * fields collapsed. Optional keys are ignored when missing (backwards compatible).
 */
export function renderGroupedSettings(schema, settings, libraries, shows) {
  const sections = new Map();
  const advanced = [];

  for (const field of schema) {
    if (field.advanced) {
      advanced.push(field);
      continue;
    }
    const name = field.section || 'Settings';
    if (!sections.has(name)) sections.set(name, []);
    sections.get(name).push(field);
  }

  const sectionHtml = [...sections.entries()]
    .map(([name, fields]) => {
      const body = renderFields(fields, settings, libraries, shows);
      return `<section class="settings-section panel">
        <h2 class="panel-title">${escapeHtml(name)}</h2>
        ${body}
      </section>`;
    })
    .join('');

  const advancedHtml =
    advanced.length > 0
      ? `<details class="advanced-block">
          <summary>Advanced</summary>
          <div class="advanced-body">${renderFields(advanced, settings, libraries, shows)}</div>
        </details>`
      : '';

  return `${sectionHtml || '<p class="muted">No settings defined.</p>'}${advancedHtml}`;
}

function renderFields(fields, settings, libraries, shows) {
  const out = [];
  let i = 0;

  while (i < fields.length) {
    const field = fields[i];
    if (field.pairWith && i + 1 < fields.length && fields[i + 1].key === field.pairWith) {
      out.push(`<div class="field-grid">
        ${renderSettingField(field, settings, libraries, shows)}
        ${renderSettingField(fields[i + 1], settings, libraries, shows)}
      </div>`);
      i += 2;
      continue;
    }
    out.push(renderSettingField(field, settings, libraries, shows));
    i += 1;
  }
  return out.join('');
}

export function renderSettingField(field, settings, libraries = [], shows = []) {
  const value =
    settings[field.key] !== undefined ? settings[field.key] : field.default;
  const help = field.help
    ? `<p class="field-help">${escapeHtml(field.help)}</p>`
    : '';

  if (field.type === 'boolean') {
    return `<div class="toggle-row">
      <div class="toggle-copy">
        <strong>${escapeHtml(field.label || field.key)}</strong>
        ${field.help ? `<span>${escapeHtml(field.help)}</span>` : ''}
      </div>
      ${checkbox(field.key, Boolean(value))}
    </div>`;
  }

  if (field.type === 'number') {
    return `<div class="field">
      <label for="f-${escapeHtml(field.key)}">${escapeHtml(field.label || field.key)}</label>
      <input id="f-${escapeHtml(field.key)}" type="number" name="${escapeHtml(field.key)}" value="${escapeHtml(value ?? '')}" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} />
      ${help}
    </div>`;
  }

  if (field.type === 'secret') {
    const isSet = Boolean(settings[`${field.key}__set`]);
    const placeholder = isSet ? '•••••••• (leave blank to keep)' : '';
    return `<div class="field">
      <label for="f-${escapeHtml(field.key)}">${escapeHtml(field.label || field.key)}</label>
      <input id="f-${escapeHtml(field.key)}" type="password" name="${escapeHtml(field.key)}" value="" autocomplete="new-password" placeholder="${escapeHtml(placeholder)}" />
      ${help}
    </div>`;
  }

  if (field.type === 'plexLibraries') {
    const selected = new Set((value || []).map(String));
    const checks = libraries
      .map(
        (lib) =>
          `<label><input type="checkbox" name="${escapeHtml(field.key)}" value="${escapeHtml(lib.id)}" ${selected.has(String(lib.id)) ? 'checked' : ''} /> ${escapeHtml(lib.title)}${lib.type ? ` <span class="muted">(${escapeHtml(lib.type)})</span>` : ''}</label>`,
      )
      .join('') || '<p class="muted">Connect Plex and ensure libraries exist.</p>';
    return `<div class="field">
      <label>${escapeHtml(field.label || field.key)}</label>
      <div class="checks">${checks}</div>
      ${help}
    </div>`;
  }

  if (field.type === 'stringList' || field.type === 'plexShows') {
    const text = Array.isArray(value) ? value.join('\n') : '';
    const placeholder =
      field.type === 'plexShows'
        ? 'One show title per line'
        : field.placeholder || '';
    return `<div class="field">
      <label for="f-${escapeHtml(field.key)}">${escapeHtml(field.label || field.key)}</label>
      <textarea id="f-${escapeHtml(field.key)}" name="${escapeHtml(field.key)}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(text)}</textarea>
      ${help}
    </div>`;
  }

  return `<div class="field">
    <label for="f-${escapeHtml(field.key)}">${escapeHtml(field.label || field.key)}</label>
    <input id="f-${escapeHtml(field.key)}" type="text" name="${escapeHtml(field.key)}" value="${escapeHtml(value ?? '')}" />
    ${help}
  </div>`;
}
