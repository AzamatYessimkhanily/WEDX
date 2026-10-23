import { supabase } from '../../data/supabase.js';
import { KEY } from '../../data/local-store.js';

const STORAGE = `${KEY}-rest-push`;
const listeners = new Set();
let owner = null, binding = null, config = null, initialized = false, initializing = null;
let busy = false, message = '', timerMessage = '', desired = null, lastRevision = 0;
const supported = () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
function stored() { try { return JSON.parse(localStorage.getItem(STORAGE) || 'null'); } catch { return null; } }
function publish() {
  for (const listener of listeners) listener();
  window.dispatchEvent(new CustomEvent('wedx-timer-push', { detail: { message: timerMessage } }));
}
function revision() {
  const key = `${STORAGE}-revision`;
  let saved = 0; try { saved = Number(localStorage.getItem(key) || 0); } catch {}
  const next = Math.max(Date.now(), saved + 1, lastRevision + 1); lastRevision = next;
  try { localStorage.setItem(key, String(next)); } catch {} return next;
}
async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('rest-notifications', { body, signal: AbortSignal.timeout(12000) });
  if (error) {
    let detail;
    try { detail = (await error.context?.json())?.error; } catch {}
    throw new Error(detail || 'Нет связи с уведомлениями. Повтори при подключении к интернету.');
  }
  return data;
}
async function readyWorker() {
  const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  if (!registration) throw new Error('Обнови WEDX и открой его заново.');
  await registration.update();
  // Existing home-screen installs may still have the previous offline worker.
  if (registration.installing) await new Promise((resolve, reject) => {
    const worker = registration.installing;
    const timeout = setTimeout(() => reject(new Error('Обновление ещё загружается. Попробуй снова.')), 12000);
    const changed = () => { if (['installed', 'activated', 'redundant'].includes(worker.state)) { clearTimeout(timeout); resolve(); } };
    worker.addEventListener('statechange', changed); changed();
  });
  if (registration.waiting) {
    const worker = registration.waiting;
    const activated = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Закрой и снова открой WEDX.')), 10000);
      worker.addEventListener('statechange', () => { if (worker.state === 'activated') { clearTimeout(timeout); resolve(); } });
    });
    worker.postMessage({ type: 'ACTIVATE_UPDATE' }); await activated;
  }
  return registration;
}
async function init(force = false) {
  if (initializing) return initializing;
  if (initialized && !force) return;
  initializing = (async () => {
    initialized = true;
    if (!supabase || !supported()) { publish(); return; }
    const { data } = await supabase.auth.getSession();
    const nextOwner = data.session?.user.id || null;
    if (owner !== nextOwner) {
      if (owner) {
        try { const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
          await (await registration?.pushManager.getSubscription())?.unsubscribe(); } catch {}
      }
      owner = nextOwner; binding = null; config = null; desired = null;
      window.dispatchEvent(new CustomEvent('wedx-push-owner', { detail: { owner } }));
    }
    if (!owner) { message = 'Сначала подключи устройство к WEDX.'; publish(); return; }
    const saved = stored();
    try {
      const expectedOwner = owner;
      const result = await invoke({ action: 'config', deviceId: saved?.owner === owner ? saved.deviceId : undefined });
      if (owner !== expectedOwner) return;
      config = result;
      const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
      const subscription = await registration?.pushManager.getSubscription();
      binding = result.enabled && saved?.owner === owner && subscription && Notification.permission === 'granted' ? saved : null;
      message = binding ? 'На Apple Watch — при заблокированном iPhone.' : '';
      if (binding) window.dispatchEvent(new Event('wedx-push-ready'));
    } catch (error) { message = error.message; }
    publish();
  })().finally(() => { initializing = null; });
  return initializing;
}
async function flushTimer(item) {
  if (!binding || !item || desired !== item) return;
  const device = binding;
  if (!navigator.onLine) {
    timerMessage = item.endAt ? 'Нет интернета — уведомление не настроено' : 'Отмена уведомления ожидает сети'; publish(); return;
  }
  timerMessage = item.endAt ? 'Настраиваем уведомление…' : 'Отменяем уведомление…'; publish();
  try {
    const remainingMs = item.endAt ? Math.max(0, Math.ceil(item.endAt - Date.now())) : 0;
    const result = await invoke({ action: remainingMs > 0 ? 'schedule' : 'cancel', deviceId: device.deviceId,
      revision: item.revision, remainingMs, label: item.label });
    if (binding !== device || desired !== item) return;
    timerMessage = result.accepted === false ? 'Таймер изменён в другом окне' : remainingMs > 0 ? 'Уведомление настроено' : '';
  } catch (error) {
    if (binding !== device || desired !== item) return;
    timerMessage = item.endAt ? 'Уведомление не настроено · проверь интернет' : 'Не удалось отменить уведомление · повтори при сети';
  }
  publish();
}
export const restNotifications = {
  setTimer(endAt, label) {
    desired = { endAt, label, revision: revision() };
    if (binding) void flushTimer(desired);
    else { timerMessage = ''; publish(); }
  },
  cancel() { this.setTimer(null, ''); },
  control() { return document.createElement('wedx-rest-notifications'); },
};

class RestNotificationControl extends HTMLElement {
  connectedCallback() {
    this.listener = () => this.render(); listeners.add(this.listener); this.render(); void init();
  }
  disconnectedCallback() { listeners.delete(this.listener); }
  render() {
    const open = this.querySelector('details')?.open;
    this.replaceChildren();
    const details = document.createElement('details'); details.className = 'rest-notifications'; details.open = Boolean(open);
    const node = (tag, value) => { const n = document.createElement(tag); n.textContent = value; return n; };
    details.append(node('summary', binding ? 'Уведомления таймера · включены' : 'Уведомления таймера'));
    const info = node('p', !supported() ? 'Открой WEDX через иконку на главном экране iPhone. Нужна iOS 16.4 или новее.'
      : message || 'Сигнал об окончании отдыха на iPhone и Apple Watch.');
    info.setAttribute('role', 'status'); details.append(info);
    const button = (label, action) => {
      const b = node('button', label); b.type = 'button'; b.disabled = busy;
      b.onclick = () => action(); details.append(b); return b;
    };
    if (supported() && owner) {
      if (!binding) button('Включить уведомления', async () => {
        // Request directly in the tap handler; iOS rejects unsolicited prompts.
        const permission = Notification.requestPermission();
        busy = true; message = ''; publish();
        try {
          if (await permission !== 'granted') throw new Error('Разреши уведомления WEDX в настройках iPhone.');
          if (!config) config = await invoke({ action: 'config' });
          const registration = await readyWorker();
          let subscription = await registration.pushManager.getSubscription();
          if (stored()?.owner && stored().owner !== owner && subscription) { await subscription.unsubscribe(); subscription = null; }
          const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
          subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          const expectedOwner = owner;
          const result = await invoke({ action: 'subscribe', subscription: subscription.toJSON() });
          if (owner !== expectedOwner) return;
          binding = { owner, deviceId: result.deviceId }; localStorage.setItem(STORAGE, JSON.stringify(binding));
          message = 'Включено. Для проверки заблокируй iPhone после нажатия кнопки ниже.';
          window.dispatchEvent(new Event('wedx-push-ready'));
        } catch (error) { message = error.message; }
        finally { busy = false; publish(); }
      });
      else {
        button('Проверить через 10 секунд', async () => {
          busy = true; publish();
          try { await invoke({ action: 'test', deviceId: binding.deviceId, revision: revision() });
            message = 'Проверка через 10 секунд. Заблокируй iPhone; часы должны быть надеты и разблокированы.';
          } catch (error) { message = error.message; }
          finally { busy = false; publish(); }
        });
        button('Выключить', async () => {
          busy = true; publish();
          try {
            await invoke({ action: 'disable', deviceId: binding.deviceId });
            const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
            await (await registration?.pushManager.getSubscription())?.unsubscribe();
            binding = null; desired = null; localStorage.removeItem(STORAGE); timerMessage = ''; message = 'Уведомления выключены.';
          } catch (error) { message = error.message; }
          finally { busy = false; publish(); }
        });
      }
    }
    this.append(details);
  }
}
customElements.define('wedx-rest-notifications', RestNotificationControl);
if (supabase) supabase.auth.onAuthStateChange(() => setTimeout(() => { void init(true); }, 0));
window.addEventListener('online', async () => { if (!binding) await init(true); if (desired) void flushTimer(desired); });
