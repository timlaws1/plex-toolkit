import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal SMTP client (AUTH LOGIN, optional STARTTLS / implicit TLS).
 * @param {{
 *   host: string,
 *   port?: number,
 *   secure?: boolean,
 *   user?: string,
 *   pass?: string,
 *   from: string,
 *   to: string,
 *   subject: string,
 *   text?: string,
 *   html?: string,
 * }} opts
 */
export async function sendMail(opts) {
  const host = String(opts.host || '').trim();
  const port = Number(opts.port || (opts.secure ? 465 : 587));
  const from = String(opts.from || '').trim();
  const to = String(opts.to || '').trim();
  const subject = String(opts.subject || '');
  if (!host) throw new Error('SMTP host is required');
  if (!from) throw new Error('From address is required');
  if (!to) throw new Error('To address is required');

  const secure = Boolean(opts.secure) || port === 465;
  const socket = await connect(host, port, secure);
  const reader = createLineReader(socket);

  try {
    await expect(reader, 220);
    await send(socket, `EHLO plex-toolkit`);
    const ehlo = await collectMultiline(reader, 250);

    if (!secure && /STARTTLS/i.test(ehlo)) {
      await send(socket, 'STARTTLS');
      await expect(reader, 220);
      const upgraded = await upgradeTls(socket, host);
      return finishSmtp(upgraded, opts, from, to, subject);
    }

    return finishSmtp(socket, opts, from, to, subject, reader, ehlo);
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

async function finishSmtp(socket, opts, from, to, subject, existingReader, existingEhlo) {
  const reader = existingReader || createLineReader(socket);
  try {
    if (!existingEhlo) {
      await send(socket, `EHLO plex-toolkit`);
      await collectMultiline(reader, 250);
    }

    if (opts.user) {
      await send(socket, 'AUTH LOGIN');
      await expect(reader, 334);
      await send(socket, Buffer.from(String(opts.user)).toString('base64'));
      await expect(reader, 334);
      await send(socket, Buffer.from(String(opts.pass || '')).toString('base64'));
      await expect(reader, 235);
    }

    await send(socket, `MAIL FROM:<${extractAddress(from)}>`);
    await expect(reader, 250);
    await send(socket, `RCPT TO:<${extractAddress(to)}>`);
    await expect(reader, 250);
    await send(socket, 'DATA');
    await expect(reader, 354);

    const message = buildMime({
      from,
      to,
      subject,
      text: opts.text,
      html: opts.html,
    });
    await send(socket, `${message}\r\n.`);
    await expect(reader, 250);
    await send(socket, 'QUIT');
    socket.end();
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

function extractAddress(value) {
  const m = String(value).match(/<([^>]+)>/);
  return (m ? m[1] : value).trim();
}

function buildMime({ from, to, subject, text, html }) {
  const boundary = `pt_${Date.now().toString(36)}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
  ];

  if (html && text) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return `${headers.join('\r\n')}\r\n\r\n` +
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${dotStuff(text)}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${dotStuff(html)}\r\n` +
      `--${boundary}--`;
  }

  if (html) {
    headers.push('Content-Type: text/html; charset=utf-8');
    return `${headers.join('\r\n')}\r\n\r\n${dotStuff(html)}`;
  }

  headers.push('Content-Type: text/plain; charset=utf-8');
  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(text || '')}`;
}

function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function dotStuff(body) {
  return String(body || '')
    .replace(/\r?\n/g, '\r\n')
    .replace(/^\./gm, '..');
}

function connect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(30_000);
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('SMTP connection timed out'));
    });
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: host },
      () => resolve(secure),
    );
    secure.on('error', reject);
  });
}

function createLineReader(socket) {
  let buffer = '';
  const lines = [];
  let waiters = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (waiters.length) {
        waiters.shift()(line);
      } else {
        lines.push(line);
      }
    }
  });

  return {
    next() {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function send(socket, line) {
  socket.write(`${line}\r\n`);
}

async function expect(reader, code) {
  // SMTP multiline replies use "250-…" continuation lines and end with "250 …"
  return collectMultiline(reader, code);
}

/** @param {{ next: () => Promise<string> }} reader */
export async function collectMultiline(reader, code) {
  const prefix = String(code);
  const lines = [];
  for (;;) {
    const line = await reader.next();
    lines.push(line);
    if (line.startsWith(`${prefix} `)) {
      break;
    }
    if (line.startsWith(`${prefix}-`)) {
      continue;
    }
    // Some servers send a bare code with no trailing space on the final line
    if (line === prefix) {
      break;
    }
    throw new Error(`SMTP unexpected response: ${line}`);
  }
  return lines.join('\n');
}
