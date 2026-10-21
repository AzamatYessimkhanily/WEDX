import { parseState } from '../domain/state.js';

// Keep the original key: upgrading at the same URL retains the phone's history.
export const KEY = 'gym-log-v1';
export const localStore = {
  read: () => localStorage.getItem(KEY),
  parse: parseState,
  write(state) {
    if (!localStorage.getItem(`${KEY}-before-v2`) && localStorage.getItem(KEY)) {
      localStorage.setItem(`${KEY}-before-v2`, localStorage.getItem(KEY));
    }
    localStorage.setItem(KEY, JSON.stringify(state));
  },
  quarantine(raw) { localStorage.setItem(`${KEY}-unreadable-${Date.now()}`, raw); },
};
