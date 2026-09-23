import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

export const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

export function socketAvailable() {
  try {
    fs.accessSync(DOCKER_SOCKET, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function dockerRequest({ method, path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, body: text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

export async function dockerJson(opts) {
  const res = await dockerRequest(opts);
  let parsed = null;
  if (res.body) {
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = null;
    }
  }
  if (res.status >= 400) {
    const message = parsed?.message || res.body || `Docker API HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return parsed;
}

export function selfContainerId() {
  return os.hostname();
}

export async function inspectContainer(id) {
  return dockerJson({ method: 'GET', path: `/containers/${encodeURIComponent(id)}/json` });
}

export async function pullImage(ref, { fromImage, tag }) {
  const params = new URLSearchParams();
  params.set('fromImage', fromImage);
  if (tag) params.set('tag', tag);
  const res = await dockerRequest({
    method: 'POST',
    path: `/images/create?${params.toString()}`,
    headers: {
      'X-Registry-Auth': Buffer.from('{}').toString('base64'),
    },
  });
  if (res.status >= 400) {
    throw new Error(res.body || `Image pull failed: HTTP ${res.status}`);
  }
  const errors = String(res.body || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row?.error);
  if (errors.length) {
    throw new Error(errors[errors.length - 1].error);
  }
  return ref;
}

export async function createContainer(name, spec) {
  return dockerJson({
    method: 'POST',
    path: `/containers/create?name=${encodeURIComponent(name)}`,
    body: spec,
  });
}

export async function startContainer(id) {
  await dockerJson({
    method: 'POST',
    path: `/containers/${encodeURIComponent(id)}/start`,
  });
}

export async function stopContainer(id) {
  await dockerJson({
    method: 'POST',
    path: `/containers/${encodeURIComponent(id)}/stop?t=15`,
  });
}

export async function renameContainer(id, name) {
  await dockerJson({
    method: 'POST',
    path: `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`,
  });
}

export async function removeContainer(id) {
  await dockerJson({
    method: 'DELETE',
    path: `/containers/${encodeURIComponent(id)}?force=1`,
  });
}

export function containerName(inspect) {
  return String(inspect?.Name || '').replace(/^\//, '');
}

export function dataMount(inspect) {
  const mounts = inspect?.Mounts || [];
  const data = mounts.find((mount) => mount.Destination === '/data' && mount.Source);
  if (!data) return null;
  return `${data.Source}:/data`;
}

/**
 * Body for Docker's container create API, copied from a running container.
 * Hostname is left unset when Docker assigned the container id, so the
 * replacement gets its own id.
 */
export function replacementSpec(inspect, image) {
  const cfg = inspect.Config || {};
  const host = inspect.HostConfig || {};
  const id = String(inspect.Id || '');
  const hostname = String(cfg.Hostname || '');
  const keepHostname = hostname && !id.startsWith(hostname);
  const networks = {};
  for (const [name, net] of Object.entries(inspect.NetworkSettings?.Networks || {})) {
    networks[name] = {
      Aliases: net.Aliases || undefined,
    };
  }

  const hostConfig = {
    Binds: host.Binds,
    PortBindings: host.PortBindings,
    RestartPolicy: host.RestartPolicy,
    NetworkMode: host.NetworkMode,
    ExtraHosts: host.ExtraHosts,
    Privileged: host.Privileged,
    PublishAllPorts: host.PublishAllPorts,
    ReadonlyRootfs: host.ReadonlyRootfs,
    Dns: host.Dns,
    DnsSearch: host.DnsSearch,
    LogConfig: host.LogConfig,
    CapAdd: host.CapAdd,
    CapDrop: host.CapDrop,
    SecurityOpt: host.SecurityOpt,
    Devices: host.Devices,
    DeviceRequests: host.DeviceRequests,
    GroupAdd: host.GroupAdd,
    ShmSize: host.ShmSize,
  };

  return {
    ...(keepHostname ? { Hostname: hostname } : {}),
    User: cfg.User,
    Env: cfg.Env,
    Cmd: cfg.Cmd,
    Entrypoint: cfg.Entrypoint,
    Image: image,
    WorkingDir: cfg.WorkingDir,
    Labels: cfg.Labels,
    ExposedPorts: cfg.ExposedPorts,
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: networks },
  };
}
