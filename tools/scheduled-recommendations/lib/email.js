function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function whereToWatch(pick) {
  if (pick.inLibrary) return 'On your Plex';
  const list = pick.providers?.length ? pick.providers : [pick.provider].filter(Boolean);
  return list.length ? list.join(', ') : 'Streaming';
}

function detailLine(pick) {
  return [
    pick.year,
    pick.certificate ? `Cert ${pick.certificate}` : null,
    pick.runtimeMinutes ? `${pick.runtimeMinutes} min` : null,
    (pick.genres || []).slice(0, 3).join(', ') || null,
  ].filter(Boolean).join(' · ');
}

/**
 * @param {{ name: string }} schedule
 * @param {Array<object>} picks
 */
export function renderRecommendationEmail(schedule, picks) {
  const subject = `${schedule.name}: ${picks.length === 1 ? '1 film' : `${picks.length} films`} to watch`;

  const text = [
    `${schedule.name}`,
    '',
    ...picks.map((pick, index) => {
      const director = pick.directors?.[0] ? `\n   Directed by ${pick.directors[0]}` : '';
      return `${index + 1}. ${pick.title}${pick.year ? ` (${pick.year})` : ''}\n   ${detailLine(pick)}\n   ${whereToWatch(pick)}${director}`;
    }),
    '',
    'Picked from your Letterboxd ratings by Plex Toolkit.',
  ].join('\n');

  const rows = picks.map((pick) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #2a3142">
        <div style="font-size:16px;font-weight:600;color:#eef1f7">${escapeHtml(pick.title)}${pick.year ? ` <span style="color:#8b95a8;font-weight:400">(${escapeHtml(pick.year)})</span>` : ''}</div>
        <div style="margin-top:4px;font-size:13px;color:#8b95a8">${escapeHtml(detailLine(pick))}</div>
        ${pick.directors?.[0] ? `<div style="margin-top:2px;font-size:13px;color:#8b95a8">Directed by ${escapeHtml(pick.directors[0])}</div>` : ''}
        <div style="margin-top:8px;display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${pick.inLibrary ? '#3a2d0a' : '#1c2a44'};color:${pick.inLibrary ? '#e5a00d' : '#8eb0ff'}">${escapeHtml(whereToWatch(pick))}</div>
      </td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#0c0e12;font-family:'Segoe UI',system-ui,sans-serif">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#161a22;border:1px solid #2a3142;border-radius:16px;padding:24px">
    <tr><td>
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#e5a00d">Recommendations</div>
      <h1 style="margin:6px 0 4px;font-size:22px;color:#eef1f7">${escapeHtml(schedule.name)}</h1>
      <p style="margin:0 0 8px;font-size:14px;color:#8b95a8">${picks.length === 1 ? 'One film' : `${picks.length} films`} picked from your Letterboxd taste.</p>
      <table role="presentation" width="100%" style="border-collapse:collapse">${rows}</table>
      <p style="margin:16px 0 0;font-size:12px;color:#8b95a8">Sent by Plex Toolkit.</p>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
