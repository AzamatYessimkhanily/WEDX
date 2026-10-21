import { parseState, stateContent } from '../domain/state.js';

export function hasLocalWork(state) {
  return Object.values(state.hist || {}).some(rows => rows.length)
    || (state.bw || []).length > 0
    || Object.keys(state.sess || {}).length > 0
    || Object.values(state.log || {}).some(rows => rows.some(row => row && (row.d || row.w || row.r)))
    || Object.keys(state.notes || {}).length > 0 || Object.keys(state.exo || {}).length > 0
    || (state.gyms || []).some(gym => !['mel', 'fs', 'avs'].includes(gym.id));
}

// Compare-and-swap protects edits made on another device. Never decide by device clocks.
export function createSyncEngine({ getState, applyState, readRemote, writeRemote, loadMeta, saveMeta, status }) {
  let meta = loadMeta() || { revision: 0, baseline: null };
  let busy = false, again = false, conflict = null, stopped = false;
  const remember = (revision, snapshot) => {
    meta = { revision, baseline: stateContent(snapshot) };
    saveMeta(meta);
  };
  const announce = value => { if (!stopped) status(value); };
  async function sync() {
    if (stopped) return;
    if (busy) { again = true; return; }
    if (conflict) { announce('conflict'); return; }
    busy = true;
    announce('syncing');
    try {
      const remote = await readRemote();
      if (stopped) return;
      // Re-read local state after the request: the user may have completed a set meanwhile.
      const current = getState();
      const localText = stateContent(current);
      if (remote) {
        remote.snapshot = parseState(JSON.stringify(remote.snapshot));
        const remoteText = stateContent(remote.snapshot);
        if (localText === remoteText) {
          remember(remote.revision, current);
          announce('saved');
          return;
        }
        if (remote.revision !== meta.revision || meta.baseline === null) {
          const clean = meta.baseline === localText || (meta.baseline === null && !hasLocalWork(current));
          if (clean) {
            applyState(remote.snapshot);
            remember(remote.revision, getState());
            announce('saved');
            return;
          }
          conflict = remote;
          announce('conflict');
          return;
        }
        if (meta.baseline === localText) { announce('saved'); return; }
      }
      const snapshot = structuredClone(getState());
      const result = await writeRemote(snapshot, remote?.revision || 0);
      if (stopped) return;
      if (result.status === 'conflict') {
        conflict = result;
        announce('conflict');
      } else {
        remember(result.revision, snapshot);
        if (stateContent(getState()) !== meta.baseline) again = true;
        announce(again ? 'pending' : 'saved');
      }
    } catch (error) {
      announce(error?.code === 'PGRST301' || error?.status === 401 ? 'expired' : 'offline');
    } finally {
      busy = false;
      if (again && !conflict && !stopped) { again = false; queueMicrotask(sync); }
    }
  }
  return {
    sync,
    stop() { stopped = true; },
    async resolve(choice) {
      if (!conflict || stopped) return;
      const remote = await readRemote(); // Recheck before resolving an older conflict.
      if (stopped) return;
      if (choice === 'remote' && remote) {
        applyState(parseState(JSON.stringify(remote.snapshot)));
        remember(remote.revision, getState());
      } else {
        // Accept only the revision, keeping local content dirty for a CAS upload.
        meta = { revision: remote?.revision || 0, baseline: remote ? stateContent(remote.snapshot) : null };
        saveMeta(meta);
      }
      conflict = null;
      await sync();
    },
  };
}
