import { supabase } from '../../data/supabase.js';
import { dailyMetrics } from './metrics.js';
import { goalsForm } from './goals.js';

const REFRESH_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }

// DOM lifecycle owns the timer and requests: navigating away or changing accounts
// disconnects the old panel before it can display an old response or keep polling.
class NutritionPanel extends HTMLElement {
  connectedCallback() {
    if (!this.rows) {
      this.status = text('p', 'Загружаем питание…');
      this.status.setAttribute('role', 'status');
      this.status.className = 'nutrition-status';
      this.rows = document.createElement('div');
      this.retry = text('button', '↻'); this.retry.type = 'button';
      this.retry.className = 'nutrition-refresh'; this.retry.setAttribute('aria-label', 'Обновить питание'); this.retry.title = 'Обновить';
      this.retry.onclick = () => this.refresh();
      this.goals = goalsForm(this.ownerId, () => this.refresh());
      const footer = document.createElement('div'); footer.className = 'nutrition-footer';
      footer.append(text('span', 'Apple Здоровье'), this.retry);
      this.append(this.status, this.rows, footer);
      if (this.settingsHost) this.settingsHost.insertBefore(this.goals, this.settingsHost.querySelector('.health-setup'));
      else this.append(this.goals);
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
        ? 'Нет интернета · показаны сохранённые данные.'
        : 'Нет интернета.';
      return;
    }
    if (this.request) return;
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.request = controller;
    this.retry.disabled = true;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const [nutrition, targets] = await Promise.all([
        supabase.from('nutrition_daily')
          .select('day,nutrition_origin,calories_kcal,protein_grams,carbs_grams,fat_grams,calories_burned,activity_status,metric_synced_at,updated_at').eq('user_id', this.ownerId)
          .order('day', { ascending: false }).limit(8).abortSignal(controller.signal),
        supabase.from('nutrition_goals').select('effective_from,base_calorie_goal,protein_goal_g,include_activity,source,updated_at')
          .eq('user_id', this.ownerId).order('effective_from', { ascending: false }).abortSignal(controller.signal),
      ]);
      const { data, error } = nutrition;
      if (this.request !== controller || !this.isConnected) return;
      if (error || targets.error) throw error || targets.error;
      this.goals.setGoals(targets.data);
      this.showDays(data, targets.data);
      this.status.textContent = '';
    } catch {
      if (this.request === controller && this.isConnected) this.status.textContent = this.hasData
        ? 'Нет связи · показаны сохранённые данные. Повторим автоматически.'
        : 'Не удалось загрузить данные. Повторим автоматически.';
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

  showDays(days, goals = []) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const signature = JSON.stringify({ days, goals, today });
    if (signature === this.signature) return;
    this.signature = signature;
    this.hasData = days.length > 0;
    const historyOpen = this.rows.querySelector('.nutrition-history')?.open;
    const openDays = new Set([...this.rows.querySelectorAll('.nutrition-day[open]')].map(row => row.dataset.day));
    const openMeta = new Set([...this.rows.querySelectorAll('.nutrition-meta[open]')].map(row => row.dataset.day));
    this.rows.replaceChildren();
    if (!days.length) {
      this.rows.append(text('p', 'Пока нет данных. Запусти «WEDX — Здоровье» на iPhone.'));
      return;
    }
    const format = value => value == null ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    const dateLabel = day => new Date(`${day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const timeLabel = value => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const history = document.createElement('details'); history.className = 'nutrition-history'; history.open = Boolean(historyOpen);
    history.append(text('summary', 'Прошлые дни'));
    days.forEach((day, index) => {
      const m = dailyMetrics(day, goals);
      const row = document.createElement(index === 0 ? 'article' : 'details');
      row.className = 'nutrition-day'; row.dataset.day = day.day;
      if (index === 0) {
        const heading = document.createElement('div'); heading.className = 'nutrition-date';
        heading.append(text('h4', day.day === today ? 'Сегодня' : dateLabel(day.day)));
        heading.append(text('span', day.day === today ? dateLabel(day.day) : 'Последняя запись'));
        row.append(heading);
      } else {
        row.open = openDays.has(day.day);
        const summary = document.createElement('summary');
        summary.append(text('strong', dateLabel(day.day)), text('span', `${format(m.calories_consumed)} ккал`), text('span', `${format(m.protein_g)} г белка`));
        row.append(summary);
      }
      const metric = (label, value, unit, className = '', key = '') => {
        const cell = document.createElement('div'); cell.className = `nutrition-metric ${className}`.trim();
        const dt = text('dt', label), dd = document.createElement('dd');
        const amount = text('span', format(value)); amount.className = 'metric-value'; dd.append(amount);
        if (value != null) { const suffix = text('span', ` ${unit}`); suffix.className = 'metric-unit'; dd.append(suffix); }
        if (value == null) { dd.setAttribute('aria-label', 'Нет данных'); dd.title = 'Нет данных'; }
        if (key && m.metric_synced_at[key] && Date.parse(m.metric_synced_at[key]) < Date.parse(m.last_synced_at)) {
          const stale = text('small', 'ранее'); stale.title = timeLabel(m.metric_synced_at[key]); cell.append(stale);
        }
        cell.prepend(dt, dd); return cell;
      };
      const energy = document.createElement('dl'); energy.className = 'nutrition-energy';
      energy.append(metric('Съедено', m.calories_consumed, 'ккал', '', 'calories'),
        metric(m.calories_remaining < 0 ? 'Сверх нормы' : 'Осталось', m.calories_remaining == null ? null : Math.abs(m.calories_remaining), 'ккал', 'nutrition-remaining'),
        metric('Активность', m.calories_burned, 'ккал', '', 'activity'));
      if (m.calories_remaining < 0) energy.classList.add('over-goal');
      const macros = document.createElement('dl'); macros.className = 'nutrition-macros';
      macros.append(metric('Белки', m.protein_g, 'г', '', 'protein'), metric('Жиры', m.fat_g, 'г', '', 'fat'), metric('Углеводы', m.carbs_g, 'г', '', 'carbs'));
      const goal = document.createElement('dl'); goal.className = 'nutrition-norm';
      goal.append(metric('Дневная норма', m.base_calorie_goal, 'ккал'));
      row.append(energy, macros, goal);
      const meta = document.createElement('details'); meta.className = 'nutrition-meta'; meta.dataset.day = day.day; meta.open = openMeta.has(day.day);
      meta.append(text('summary', day.updated_at ? `Обновлено ${timeLabel(day.updated_at)}` : 'О данных'));
      const activityNotes = {
        unknown: 'Активность ещё не передана.', no_data: 'Нет данных об активности.',
        multiple_sources: 'Расход не определён: несколько источников активности.', overlap: 'Расход не определён: записи активности пересекаются.',
        health_total: 'Активность: дневной итог «Здоровья».', verified: 'Активность: записи YAZIO.',
      };
      meta.append(text('p', activityNotes[m.activity_status]));
      meta.append(text('p', m.goal_source ? `Норма без активности задана вручную с ${dateLabel(m.goal_effective_from)}. ${m.include_activity ? 'Остаток = норма + активность − съедено.' : 'Остаток = норма − съедено.'}` : 'Дневная норма не задана.'));
      const times = text('p', [['calories', 'Калории'], ['protein', 'Белок'], ['carbs', 'Углеводы'], ['fat', 'Жиры'], ['activity', 'Активность']]
        .filter(([key]) => m.metric_synced_at[key]).map(([key, label]) => `${label}: ${timeLabel(m.metric_synced_at[key])}`).join(' · '));
      times.className = 'metric-times'; meta.append(times); row.append(meta);
      if (index === 0) this.rows.append(row); else history.append(row);
    });
    if (days.length > 1) this.rows.append(history);
  }

}

customElements.define('wedx-nutrition', NutritionPanel);

export function nutritionPanel(userId, settingsHost = null) {
  const panel = document.createElement('wedx-nutrition');
  panel.ownerId = userId; panel.settingsHost = settingsHost;
  return panel;
}
