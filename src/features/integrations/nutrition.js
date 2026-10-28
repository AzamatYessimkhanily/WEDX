import { healthShortcutUrl } from './health-shortcut.js';
import { supabase } from '../../data/supabase.js';
import { loadNutritionHistory } from '../../data/nutrition-history.js';
import { dailyMetrics, nutritionStatus } from './metrics.js';
import { localDay, nutritionCalendar } from './calendar.js';
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
        loadNutritionHistory(supabase, this.ownerId, controller.signal),
        supabase.from('nutrition_goals').select('effective_from,base_calorie_goal,protein_goal_g,protein_per_kg,include_activity,source,updated_at')
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
    const today = localDay(), weights = this.getWeights?.() || [];
    const signature = JSON.stringify({ days, goals, weights, today });
    if (signature === this.signature) return;
    this.signature = signature;
    this.hasData = days.length > 0;
    this.days = days; this.targets = goals; this.weights = weights; this.today = today;
    if (!this.selectedDate || this.followLatest || !days.some(day => day.day === this.selectedDate)) {
      this.selectedDate = days[0]?.day;
      this.month = this.selectedDate?.slice(0, 7);
      this.followLatest = true;
    }
    this.renderDays();
  }

  renderDays() {
    const { days, targets: goals, weights, today } = this;
    const focused = this.rows.contains(document.activeElement) ? document.activeElement.dataset.calendarFocus : null;
    const metaOpen = this.rows.querySelector('.nutrition-meta')?.open;
    this.rows.replaceChildren();
    if (!days.length) {
      this.rows.append(text('p', 'Пока нет данных. Запусти «WEDX — Здоровье» на iPhone.'));
      return;
    }
    const metrics = new Map(days.map(day => [day.day, dailyMetrics(day, goals, weights)]));
    this.rows.append(nutritionCalendar({ metrics, month: this.month, selectedDate: this.selectedDate, today,
      onSelect: date => { this.selectedDate = date; this.followLatest = date === days[0].day; this.renderDays(); },
      onMonth: month => { this.month = month; this.selectedDate = days.find(day => day.day.startsWith(month)).day;
        this.followLatest = false; this.renderDays(); },
    }));
    const day = days.find(day => day.day === this.selectedDate), m = metrics.get(day.day);
    const format = value => value == null ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    const dateLabel = date => new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const timeLabel = value => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const row = document.createElement('article'); row.className = 'nutrition-day'; row.dataset.day = day.day;
    const heading = document.createElement('div'); heading.className = 'nutrition-date';
    heading.append(text('h4', day.day === today ? 'Сегодня' : dateLabel(day.day)));
    if (day.day === today) heading.append(text('span', 'День ещё идёт'));
    row.append(heading);
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
    const protein = document.createElement('div'); protein.className = 'nutrition-protein';
    const status = nutritionStatus(m, today);
    if (m.protein_goal_g != null && m.protein_g != null) {
      const heading = document.createElement('div'); heading.className = 'protein-heading';
      const left = Math.max(0, Math.ceil(m.protein_remaining_g));
      heading.append(text('strong', `Белок ${format(m.protein_g)} / ${format(m.protein_goal_g)} г`),
        text('span', left ? `${day.day < today ? 'Недобор' : 'Ещё'} ${left} г` : 'Цель набрана'));
      const progress = document.createElement('progress'); progress.max = m.protein_goal_g;
      progress.value = Math.min(m.protein_g, m.protein_goal_g); progress.setAttribute('aria-label', 'Белок за день');
      protein.append(heading, progress, text('small', `${format(m.protein_per_kg)} г/кг × ${format(m.protein_weight_kg)} кг`));
      if (status.lowProtein) protein.classList.add('low');
    } else protein.append(text('span', m.protein_weight_kg == null ? 'Для цели белка добавь замер веса в «Прогрессе».' : 'Белок ещё не передан.'));
    row.append(energy);
    if (m.calories_remaining == null) {
      const reason = m.base_calorie_goal == null
        ? 'Для расчёта «Осталось» нужна дневная норма, действовавшая в эту дату.'
        : m.calories_consumed == null
          ? 'Для расчёта «Осталось» нужны данные о съеденных калориях за этот день.'
          : 'Для расчёта «Осталось» нужны данные об активности за этот день.';
      const note = text('p', reason); note.className = 'nutrition-explanation'; row.append(note);
    }
    row.append(macros, protein, goal);
    if (m.activity_status === 'health_total') {
      const note = text('p', 'Старый импорт мог завышать активность. ');
      const update = text('a', 'Обновить команду'); update.href = healthShortcutUrl;
      note.append(update); row.append(note);
    }
    const meta = document.createElement('details'); meta.className = 'nutrition-meta'; meta.dataset.day = day.day; meta.open = Boolean(metaOpen);
    meta.append(text('summary', day.updated_at ? `Обновлено ${timeLabel(day.updated_at)}` : 'О данных'));
    const activityNotes = {
      unknown: 'Активность ещё не передана.', no_data: 'Нет данных об активности.',
      multiple_sources: 'Расход не определён: несколько источников активности.', overlap: 'Расход не определён: записи активности пересекаются.',
      health_total: 'Расход нужно повторно получить из одного источника.', verified: 'Активность: один источник «Здоровья».',
    };
    meta.append(text('p', activityNotes[m.activity_status]));
    if (m.protein_weight_date) meta.append(text('p', `Белок: ориентир ${format(m.protein_per_kg)} г/кг, замер веса от ${dateLabel(m.protein_weight_date)}.`));
    meta.append(text('p', m.goal_source ? `Норма без активности задана вручную с ${dateLabel(m.goal_effective_from)}. ${m.include_activity ? 'Остаток = норма + активность − съедено.' : 'Остаток = норма − съедено.'}` : 'Дневная норма не задана.'));
    const times = text('p', [['calories', 'Калории'], ['protein', 'Белок'], ['carbs', 'Углеводы'], ['fat', 'Жиры'], ['activity', 'Активность']]
      .filter(([key]) => m.metric_synced_at[key]).map(([key, label]) => `${label}: ${timeLabel(m.metric_synced_at[key])}`).join(' · '));
    times.className = 'metric-times'; meta.append(times); row.append(meta);
    this.rows.append(row);
    if (focused) {
      const buttons = [...this.rows.querySelectorAll('[data-calendar-focus]')];
      const target = buttons.find(button => button.dataset.calendarFocus === focused && !button.disabled)
        || buttons.find(button => button.dataset.calendarFocus === this.selectedDate);
      target?.focus({ preventScroll: true });
    }
  }

}

customElements.define('wedx-nutrition', NutritionPanel);

export function nutritionPanel(userId, settingsHost = null, getWeights = () => []) {
  const panel = document.createElement('wedx-nutrition');
  panel.ownerId = userId; panel.settingsHost = settingsHost; panel.getWeights = getWeights;
  return panel;
}
