// utils/pslist-wrapper.mjs
import psList from 'ps-list';

let cache = null;
let lastFetch = 0;
let inflight = null;

export async function getProcesses() {
  const now = Date.now();
  if (cache && now - lastFetch < 1000) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const list = await psList();
    cache = list;
    lastFetch = Date.now();
    return list;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
