import { applyUpdate } from './apply.js';

const containerId = process.env.UPDATE_CONTAINER_ID;
const image = process.env.UPDATE_IMAGE;

if (!containerId || !image) {
  console.error('UPDATE_CONTAINER_ID and UPDATE_IMAGE are required');
  process.exit(1);
}

await new Promise((resolve) => setTimeout(resolve, 1500));

try {
  const result = await applyUpdate({ containerId, image });
  console.log(result.updated ? 'Update applied' : 'Already current');
  process.exit(0);
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
