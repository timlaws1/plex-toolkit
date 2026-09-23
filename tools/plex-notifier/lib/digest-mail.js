function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reasonLabel(item) {
  if (item.reason === 'watchlist') return 'On your watchlist';
  if (item.personName) return `Featuring ${item.personName}`;
  return 'Tracked person';
}

function typeLabel(item) {
  if (item.mediaType === 'movie') return 'Movie';
  if (item.mediaType === 'tv') return 'TV';
  return '';
}

function formatDay(iso) {
  if (!iso) return 'Date to be confirmed';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Date to be confirmed';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function groupByDay(items) {
  const groups = [];
  const index = new Map();
  const sorted = items
    .slice()
    .sort((a, b) => String(a.startsAt || '').localeCompare(String(b.startsAt || '')));

  for (const item of sorted) {
    const day = formatDay(item.startsAt);
    if (!index.has(day)) {
      const group = { day, items: [] };
      index.set(day, group);
      groups.push(group);
    }
    index.get(day).items.push(item);
  }
  return groups;
}

function itemLine(item) {
  const year = item.year ? ` (${item.year})` : '';
  const when = [formatDay(item.startsAt), formatTime(item.startsAt)].filter(Boolean).join(' ');
  const channel = item.channel || 'Channel TBA';
  const also = item.alsoOn?.length ? ` · also ${item.alsoOn.join(', ')}` : '';
  return `${item.title || 'Untitled'}${year} — ${channel}${also} — ${when} — ${reasonLabel(item)}`;
}

/**
 * HTML + plain-text body for the Freeview digest.
 * @param {Array<object>} items
 */
export function renderDigestEmail(items) {
  const count = items.length;
  const subject =
    count === 1
      ? `${items[0].title || '1 title'} is on Freeview`
      : `${count} titles on Freeview this week`;

  const intro =
    count === 1
      ? 'One title from your watchlist or the people you follow.'
      : `${count} titles from your watchlist or the people you follow.`;

  const text = [`On Freeview this week`, '', intro, '', ...groupByDay(items).flatMap((group) => [
    group.day,
    ...group.items.map((item) => `  ${itemLine(item)}`),
    '',
  ])].join('\n');

  const cards = groupByDay(items)
    .map((group) => {
      const rows = group.items
        .map((item) => {
          const title = escapeHtml(item.title || 'Untitled');
          const year = item.year
            ? `<span style="color:#8b93a7;font-weight:400;"> ${escapeHtml(item.year)}</span>`
            : '';
          const kind = typeLabel(item);
          const kindHtml = kind
            ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#2a2416;color:#e5a00d;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(kind)}</span>`
            : '';
          const time = formatTime(item.startsAt);
          const channel = escapeHtml(item.channel || 'Channel TBA');
          const when = time ? `${channel} &middot; ${escapeHtml(time)}` : channel;
          const also = item.alsoOn?.length
            ? `<div style="margin-top:4px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;color:#8b93a7;">Also on ${item.alsoOn.map((label) => escapeHtml(label)).join(' &middot; ')}</div>`
            : '';
          return `<tr>
            <td style="padding:0 0 10px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#161a22;border:1px solid #2a3142;border-radius:12px;">
                <tr>
                  <td style="padding:16px 18px;border-left:3px solid #e5a00d;border-radius:12px;">
                    <div style="font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:1.3;color:#eef1f7;">${title}${year}${kindHtml}</div>
                    <div style="margin-top:8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#d5dbe8;">${when}</div>
                    ${also}
                    <div style="margin-top:8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.02em;color:#e5a00d;">${escapeHtml(reasonLabel(item))}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
        })
        .join('');

      return `<tr>
        <td style="padding:18px 0 8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#8b93a7;">${escapeHtml(group.day)}</td>
      </tr>
      ${rows}`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#0c0e12;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(intro)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0c0e12;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
          <tr>
            <td style="padding:0 0 8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#e5a00d;">Plex Notifier</td>
          </tr>
          <tr>
            <td style="padding:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;color:#eef1f7;">On Freeview this week</td>
          </tr>
          <tr>
            <td style="padding:0 0 8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#b7c0d0;">${escapeHtml(intro)}</td>
          </tr>
          ${cards}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
