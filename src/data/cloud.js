import { KEY, localStore } from './local-store.js';
import { supabase, backendConfigured } from './supabase.js';
import { createSyncEngine } from './sync-engine.js';
import { integrationsPanel } from '../features/integrations/panel.js';

const labels = {
  local: 'Сохранено в этом устройстве',
  setup: 'Сохранено в этом устройстве · облако ещё не настроено',
  pending: 'Сохранено в устройстве · ожидает отправки',
  syncing: 'Синхронизация…', saved: 'Сохранено в облаке и в устройстве',
  offline: 'Нет связи с облаком · изменения сохранены в устройстве',
  expired: 'Войди снова для синхронизации · данные сохранены в устройстве',
  conflict: 'На другом устройстве есть изменения. Выбери копию для продолжения.',
};
function node(tag, value) { const n = document.createElement(tag); if (value) n.textContent = value; return n; }
function action(label, fn) { const b = node('button', label); b.type = 'button'; b.onclick = fn; return b; }
function download(state, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function createCloud({ getState, applyState, onChange, toast }) {
  let user = null, engine = null, timer = null, currentStatus = backendConfigured ? 'local' : 'setup';
  const setStatus = value => { currentStatus = value; onChange(); };
  const readRemote = async () => {
    const { data, error } = await supabase.from('workout_state').select('snapshot,revision').maybeSingle();
    if (error) throw error;
    return data;
  };
  function attach(next) {
    if (next?.id === user?.id) return;
    engine?.stop(); clearTimeout(timer); engine = null;
    user = next;
    if (!user) { setStatus('local'); repaint(); return; }
    const owner = localStorage.getItem(`${KEY}-owner`);
    if (owner && owner !== user.id) {
      localStorage.setItem(`${KEY}-account-${owner}`, JSON.stringify(getState()));
      const raw = localStorage.getItem(`${KEY}-account-${user.id}`);
      applyState(raw ? localStore.parse(raw) : { log: {}, last: {}, hist: {}, done: {} });
      // The undo snapshot belongs to the previous account; it must not be offered here.
      localStorage.removeItem(`${KEY}-undo`);
    }
    localStorage.setItem(`${KEY}-owner`, user.id);
    const metaKey = `${KEY}-sync-${user.id}`;
    const ownerId = user.id;
    engine = createSyncEngine({ getState, applyState, readRemote,
      writeRemote: async (snapshot, revision) => {
        const { data, error } = await supabase.rpc('save_workout_state', { p_snapshot: snapshot, p_expected_revision: revision, p_user_id: ownerId });
        if (error) throw error;
        return data;
      },
      loadMeta: () => { try { return JSON.parse(localStorage.getItem(metaKey)); } catch { return null; } },
      saveMeta: meta => localStorage.setItem(metaKey, JSON.stringify(meta)), status: setStatus,
    });
    repaint(); engine.sync();
  }
  function repaint() {
    document.querySelectorAll('[data-cloud-box]').forEach(box => box.replaceWith(render()));
  }
  async function importGist() {
    try {
      const legacy = JSON.parse(localStorage.getItem(`${KEY}-cloud`) || 'null');
      const token = legacy?.token || prompt('Токен GitHub для чтения прежней копии (не отправляется в Supabase):');
      if (!token) return;
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
      let id = legacy?.id;
      if (!id) {
        const res = await fetch('https://api.github.com/gists?per_page=100', { headers });
        if (!res.ok) throw new Error();
        id = (await res.json()).find(gist => gist.files?.['wedx-gym-log.json'])?.id;
      }
      if (!id) throw new Error();
      const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(id)}`, { headers });
      if (!res.ok) throw new Error();
      const file = (await res.json()).files?.['wedx-gym-log.json'];
      if (!file) throw new Error();
      let raw = file.content;
      if (file.truncated) {
        const response = await fetch(file.raw_url);
        if (!response.ok) throw new Error();
        raw = await response.text();
      }
      const restored = localStore.parse(raw);
      if (!confirm('Загрузить прежнюю копию из GitHub? Текущая копия останется в резерве на устройстве.')) return;
      applyState(restored); changed(); toast('Копия из GitHub загружена');
    } catch { toast('Не удалось прочитать копию GitHub'); }
  }
  function changed() {
    if (!engine) return;
    if (currentStatus !== 'conflict') setStatus('pending');
    clearTimeout(timer); timer = setTimeout(() => engine?.sync(), 1200);
  }
  function render() {
    const box = node('div'); box.className = 'cloudbox'; box.dataset.cloudBox = '';
    const status = node('p', labels[currentStatus]); status.dataset.syncStatus = ''; status.setAttribute('role', 'status');
    box.append(node('h3', 'Данные и подключения'), status);
    if (!backendConfigured) box.append(node('p', 'Тренировки работают локально. После подключения проекта Supabase здесь появится вход и синхронизация.'));
    else if (!user) {
      const form = node('form'); form.className = 'account-form';
      const email = node('input'); email.type = 'email'; email.autocomplete = 'email'; email.placeholder = 'Email'; email.required = true; email.setAttribute('aria-label', 'Email');
      const password = node('input'); password.type = 'password'; password.autocomplete = 'current-password'; password.placeholder = 'Пароль'; password.minLength = 8; password.required = true; password.setAttribute('aria-label', 'Пароль');
      const feedback = node('p'); feedback.setAttribute('role', 'status');
      const login = node('button', 'Войти'); login.type = 'submit';
      const signup = action('Создать аккаунт', async () => {
        if (!form.reportValidity()) return;
        signup.disabled = true;
        try {
          const { error } = await supabase.auth.signUp({ email: email.value, password: password.value, options: { emailRedirectTo: location.origin + import.meta.env.BASE_URL } });
          feedback.textContent = error ? 'Не удалось создать аккаунт. Проверь email и пароль или попробуй позже.' : 'Проверь почту: подтверди адрес, затем войди.';
        } catch { feedback.textContent = 'Нет связи. Попробуй позже.'; }
        finally { signup.disabled = false; }
      });
      form.onsubmit = async event => {
        event.preventDefault(); login.disabled = true;
        try {
          const { data, error } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value });
          if (error) feedback.textContent = 'Не удалось войти. Проверь пароль и подтверждение email.';
          else attach(data.user);
        } catch { feedback.textContent = 'Нет связи. Попробуй позже.'; }
        finally { login.disabled = false; }
      };
      form.append(email, password, login, signup, feedback); box.append(form);
    } else {
      box.append(node('p', user.email));
      box.append(action('Синхронизировать', () => engine.sync()));
      box.append(action('Выйти из аккаунта', async () => {
        if (currentStatus !== 'saved' && !confirm('Есть изменения, которые ещё не отправлены. Выйти? Они останутся в этом устройстве.')) return;
        await supabase.auth.signOut({ scope: 'local' }); attach(null);
      }));
      const conflict = node('div'); conflict.dataset.syncConflict = ''; conflict.hidden = currentStatus !== 'conflict';
      conflict.append(node('p', 'Перед заменой сохрани обе копии. Автоматически объединять разные правки пока нельзя.'));
      conflict.append(action('Скачать копию устройства', () => download(getState(), 'wedx-device.json')));
      conflict.append(action('Скачать облачную копию', async () => { try { const remote = await readRemote(); if (remote) download(remote.snapshot, 'wedx-cloud.json'); } catch { toast('Нет связи с облаком'); } }));
      for (const [label, choice] of [['Оставить копию устройства', 'local'], ['Загрузить облачную копию', 'remote']]) {
        conflict.append(action(label, async () => {
          if (!confirm('Продолжить с выбранной копией? Другая версия будет заменена; сохрани её файлом, если она нужна.')) return;
          try { await engine.resolve(choice); } catch { toast('Нет связи. Обе копии сохранены.'); }
        }));
      }
      box.append(conflict, integrationsPanel(user));
    }
    const legacy = node('details'); legacy.append(node('summary', 'Перенос со старой версии'));
    legacy.append(node('p', 'При прежнем адресе история сохраняется автоматически. На новом адресе используй «Копия данных» → файл в старом приложении и восстанови его здесь.'));
    legacy.append(action('Загрузить прежнюю копию GitHub', importGist)); box.append(legacy);
    return box;
  }
  return {
    render, changed,
    updateStatus() {
      document.querySelectorAll('[data-sync-status]').forEach(n => { n.textContent = labels[currentStatus]; });
      document.querySelectorAll('[data-sync-conflict]').forEach(n => { n.hidden = currentStatus !== 'conflict'; });
    },
    async start() {
      if (!supabase) return;
      supabase.auth.onAuthStateChange((_event, session) => { setTimeout(() => attach(session?.user || null), 0); });
      try { const { data } = await supabase.auth.getSession(); attach(data.session?.user || null); }
      catch { setStatus('offline'); }
      window.addEventListener('online', () => engine?.sync());
      setInterval(() => { if (document.visibilityState === 'visible') engine?.sync(); }, 60_000);
    },
    sync() { engine?.sync(); },
    flush() { clearTimeout(timer); engine?.sync(); },
  };
}
