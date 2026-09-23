import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  containerName,
  createContainer,
  dataMount,
  dockerJson,
  inspectContainer,
  pullImage,
  removeContainer,
  renameContainer,
  replacementSpec,
  selfContainerId,
  socketAvailable,
  startContainer,
  stopContainer,
} from './docker.js';
import { imageRefFromInspect, splitImageRef } from './version.js';

const UPDATER_NAME = 'plex-toolkit-updater';

function statusPath() {
  return path.join(config.configDir, 'update-status.json');
}

export function readUpdateResult() {
  try {
    return JSON.parse(fs.readFileSync(statusPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeUpdateResult(status) {
  try {
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(
      statusPath(),
      JSON.stringify({ ...status, at: new Date().toISOString() }),
    );
  } catch {
    // The helper may be the process that can write this; ignore if /data is missing.
  }
}

export async function inspectSelf() {
  return inspectContainer(selfContainerId());
}

export async function canApplyUpdate() {
  if (!socketAvailable()) return false;
  try {
    await inspectSelf();
    return true;
  } catch {
    return false;
  }
}

export async function startUpdate() {
  if (!socketAvailable()) {
    throw new Error(
      'Mount /var/run/docker.sock and add this container to the docker group to update from the app.',
    );
  }
  const self = await inspectSelf();
  const image = imageRefFromInspect(self);
  await removeUpdaterIfStopped();

  const binds = ['/var/run/docker.sock:/var/run/docker.sock'];
  const data = dataMount(self);
  if (data) binds.push(data);

  const created = await createContainer(UPDATER_NAME, {
    Image: self.Image,
    User: '0:0',
    WorkingDir: '/app',
    Cmd: ['node', 'src/update/helper.js'],
    Env: [
      `UPDATE_CONTAINER_ID=${self.Id}`,
      `UPDATE_IMAGE=${image}`,
      'DATA_DIR=/data',
      'NODE_ENV=production',
    ],
    HostConfig: {
      Binds: binds,
      AutoRemove: false,
      RestartPolicy: { Name: 'no' },
    },
  });
  await startContainer(created.Id);
  return { image, name: containerName(self) };
}

async function removeUpdaterIfStopped() {
  try {
    const existing = await inspectContainer(UPDATER_NAME);
    const running = existing?.State?.Running;
    if (running) {
      throw new Error('An update is already running.');
    }
    await removeContainer(existing.Id);
  } catch (err) {
    if (err.status === 404 || /no such container/i.test(err.message || '')) return;
    throw err;
  }
}

/**
 * Runs inside the updater container. Pulls the image and swaps the app container.
 */
export async function applyUpdate({ containerId, image }) {
  writeUpdateResult({ state: 'running', message: `Pulling ${image}` });
  const parts = splitImageRef(image);
  await pullImage(image, parts);

  const current = await inspectContainer(containerId);
  const pulled = await dockerJson({
    method: 'GET',
    path: `/images/${parts.fromImage}:${parts.tag || 'latest'}/json`,
  }).catch(() => null);
  if (pulled?.Id && pulled.Id === current.Image) {
    writeUpdateResult({
      state: 'current',
      message: 'This container is already running the newest image.',
    });
    return { updated: false };
  }

  const name = containerName(current);
  const oldName = `${name}-previous`;
  const nextName = `${name}-next`;
  await removeIfPresent(oldName);
  await removeIfPresent(nextName);

  const created = await createContainer(nextName, replacementSpec(current, image));
  try {
    await stopContainer(containerId);
    await renameContainer(containerId, oldName);
    await renameContainer(created.Id, name);
    await startContainer(created.Id);
    await removeContainer(containerId);
    writeUpdateResult({
      state: 'updated',
      message: `Updated ${name} to ${image}.`,
    });
    return { updated: true };
  } catch (err) {
    writeUpdateResult({ state: 'failed', message: err.message });
    try {
      await stopContainer(created.Id);
    } catch {
      // The new container may never have started.
    }
    try {
      await renameContainer(created.Id, nextName);
    } catch {
      // Already named.
    }
    try {
      await renameContainer(containerId, name);
      await startContainer(containerId);
    } catch (restoreErr) {
      writeUpdateResult({
        state: 'failed',
        message: `${err.message}. Restoring the previous container failed: ${restoreErr.message}`,
      });
    }
    throw err;
  }
}

async function removeIfPresent(name) {
  try {
    const existing = await inspectContainer(name);
    await removeContainer(existing.Id);
  } catch (err) {
    if (err.status === 404 || /no such container/i.test(err.message || '')) return;
    throw err;
  }
}
