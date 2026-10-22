import { supabase } from '../../data/supabase.js';

const REFRESH_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }

// DOM lifecycle owns the timer and requests: navigating away or changing accounts
// disconnects the old panel before it can display an old response or keep polling.
class NutritionPanel extends HTMLElement {
  connectedCallback() {
    if (!this.rows) {
      this.append(text('h4', 'Записано в YAZIO'));
      this.append(text('p', 'Калории и белок за последние 8 дней с записями. Пропуски не считаются нулём; наличие записей не означает, что дневник заполнен полностью.'));
      this.status = text('p', 'Загружаем питание…');
      this.status.setAttribute('role', 'status');
      this.status.className = 'nutrition-status';
      this.rows = document.createElement('div');
      this.retry = text('button', 'Обновить питание'); this.retry.type = 'button';
      this.retry.onclick = () => this.refresh();
      this.append(this.status, this.rows, this.retry);
    }
    this.events = new AbortController();
    const options = { signal: this.events.signal };
    const resume = () => this.refresh();
    document.addEventListener('visibilitychange', resume, options);
    for (const event of ['focus', 'pageshow', 'online', 'offline']) window.addEventListener(event, resume, options);
    window.addEventListener('pagehide', () => this.pause(), options);
    this.refresh();
  }

  disconnectedCallback() {
    this.events?.abort();
    this.pause();
  }

  pause() {
    clearTimeout(this.timer);
    this.request?.abort();
    this.request = null;
    if (this.retry) this.retry.disabled = false;
  }

  async refresh() {
    if (!this.isConnected || !this.ownerId) return;
    if (!navigator.onLine || document.visibilityState !== 'visible') {
      this.pause();
      if (!navigator.onLine) this.status.textContent = this.hasData
        ? 'Нет интернета. Показываем последние загруженные данные; обновим после подключения.'
        : 'Нет интернета. Питание загрузится после подключения.';
      return;
    }
    if (this.request) return;
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.request = controller;
    this.retry.disabled = true;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { data, error } = await supabase.from('nutrition_daily')
        .select('day,calories_kcal,protein_grams,updated_at').eq('user_id', this.ownerId)
        .order('day', { ascending: false }).limit(8).abortSignal(controller.signal);
      if (this.request !== controller || !this.isConnected) return;
      if (error) throw error;
      this.showDays(data);
      this.status.textContent = 'Обновляется автоматически при открытии и каждые 15 секунд.';
    } catch {
      if (this.request === controller && this.isConnected) this.status.textContent = this.hasData
        ? 'Связь с питанием временно недоступна. Показываем последние данные; повторим автоматически.'
        : 'Не удалось загрузить питание. Повторим автоматически.';
    } finally {
      clearTimeout(timeout);
      if (this.request === controller) {
        this.request = null;
        this.retry.disabled = false;
        if (this.isConnected && navigator.onLine && document.visibilityState === 'visible') {
          this.timer = setTimeout(() => this.refresh(), REFRESH_MS);
        }
      }
    }
  }

  showDays(days) {
    const signature = JSON.stringify(days);
    if (signature === this.signature) return;
    this.signature = signature;
    this.hasData = days.length > 0;
    this.rows.replaceChildren();
    if (!days.length) {
      this.rows.append(text('p', 'Импортов пока нет. После настройки команды здесь появятся калории и белок из YAZIO.'));
      return;
    }
    const latest = days.reduce((value, day) => day.updated_at > value ? day.updated_at : value, '');
    if (latest) this.rows.append(text('p', `Последнее обновление: ${new Date(latest).toLocaleString('ru-RU')}`));
    for (const day of days) {
      const row = document.createElement('div'); row.className = 'nutrition-day';
      row.append(text('strong', new Date(`${day.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })));
      row.append(text('span', `${Number(day.calories_kcal).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ккал`));
      row.append(text('span', `${Number(day.protein_grams).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} г белка`));
      this.rows.append(row);
    }
  }
}

customElements.define('wedx-nutrition', NutritionPanel);

export function nutritionPanel(userId) {
  const panel = document.createElement('wedx-nutrition');
  panel.ownerId = userId;
  return panel;
}
