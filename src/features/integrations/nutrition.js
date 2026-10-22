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
      this.append(text('h4', 'Записано в YAZIO'));
      this.append(text('p', 'Питание и активность за последние 8 дней с записями. Пропуски не считаются нулём; наличие записей не означает, что дневник заполнен полностью.'));
      this.status = text('p', 'Загружаем питание…');
      this.status.setAttribute('role', 'status');
      this.status.className = 'nutrition-status';
      this.rows = document.createElement('div');
      this.retry = text('button', 'Обновить питание'); this.retry.type = 'button';
      this.retry.onclick = () => this.refresh();
      this.append(this.status, this.rows, this.retry, goalsForm(this.ownerId, () => this.refresh()));
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
      const [nutrition, targets] = await Promise.all([
        supabase.from('nutrition_daily')
          .select('day,calories_kcal,protein_grams,carbs_grams,fat_grams,calories_burned,activity_status,metric_synced_at,updated_at').eq('user_id', this.ownerId)
          .order('day', { ascending: false }).limit(8).abortSignal(controller.signal),
        supabase.from('nutrition_goals').select('effective_from,base_calorie_goal,protein_goal_g,include_activity,source,updated_at')
          .eq('user_id', this.ownerId).order('effective_from', { ascending: false }).abortSignal(controller.signal),
      ]);
      const { data, error } = nutrition;
      if (this.request !== controller || !this.isConnected) return;
      if (error || targets.error) throw error || targets.error;
      this.showDays(data, targets.data);
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

  showDays(days, goals = []) {
    const signature = JSON.stringify({ days, goals });
    if (signature === this.signature) return;
    this.signature = signature;
    this.hasData = days.length > 0;
    this.rows.replaceChildren();
    if (!days.length) {
      this.rows.append(text('p', 'Импортов пока нет. После запуска команды здесь появятся показатели из YAZIO.'));
      return;
    }
    const latest = days.reduce((value, day) => day.updated_at > value ? day.updated_at : value, '');
    if (latest) this.rows.append(text('p', `Последнее обновление: ${new Date(latest).toLocaleString('ru-RU')}`));
    const format = value => value == null ? 'нет данных' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    for (const day of days) {
      const m = dailyMetrics(day, goals);
      const row = document.createElement('details'); row.className = 'nutrition-day';
      const summary = document.createElement('summary');
      summary.append(text('strong', new Date(`${day.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })));
      summary.append(text('span', `${format(m.calories_consumed)} ккал`));
      summary.append(text('span', `${format(m.protein_g)} г белка`)); row.append(summary);
      const values = document.createElement('dl'); values.className = 'nutrition-metrics';
      for (const [label, value, unit] of [
        ['Углеводы', m.carbs_g, 'г'], ['Жиры', m.fat_g, 'г'], ['Расход активности YAZIO', m.calories_burned, 'ккал'],
        ['Базовый лимит', m.base_calorie_goal, 'ккал'], ['Лимит с учётом настройки активности', m.adjusted_calorie_goal, 'ккал'],
        ['Остаток калорий', m.calories_remaining, 'ккал'], ['Цель белка', m.protein_goal_g, 'г'],
        ['Остаток белка', m.protein_remaining_g, 'г'], ['Съедено минус лимит', m.calorie_balance, 'ккал'],
      ]) values.append(text('dt', label), text('dd', value == null ? 'нет данных' : `${format(value)} ${unit}`));
      row.append(values);
      const activityNotes = {
        unknown: 'Расход за этот день ещё не передан. Новая команда обновляет активность за сегодня и вчера.',
        no_data: 'Нет записей расхода: проверь доступ к активной энергии. Отсутствие записей не означает нулевой расход.',
        multiple_sources: 'Есть записи других источников активности. Расход не суммируем: в «Здоровье» он рассчитывается с учётом приоритета источников.',
        overlap: 'Записи активности пересекаются или проходят через полночь. Расход требует проверки и не участвует в расчёте лимита.',
        verified: 'Расход — активная энергия YAZIO без пересекающихся записей, не полный расход организма за день.',
      };
      row.append(text('p', activityNotes[m.activity_status]));
      row.append(text('p', m.goal_source ? `Лимиты заданы вручную с ${new Date(m.goal_effective_from + 'T12:00:00').toLocaleDateString('ru-RU')}. Активность ${m.include_activity ? 'учитывается' : 'не учитывается'}. Отрицательный остаток означает превышение цели. Баланс относительно лимита не равен физиологическому дефициту.` : 'Лимиты для этого дня не заданы. Сохрани их ниже, чтобы видеть остатки.'));
      const times = document.createElement('p'); times.className = 'metric-times';
      times.textContent = [['calories', 'Калории'], ['protein', 'Белок'], ['carbs', 'Углеводы'], ['fat', 'Жиры'], ['activity', 'Активность']]
        .filter(([key]) => m.metric_synced_at[key]).map(([key, label]) => `${label}: ${new Date(m.metric_synced_at[key]).toLocaleString('ru-RU')}`).join(' · ');
      row.append(times); this.rows.append(row);
    }
  }
}

customElements.define('wedx-nutrition', NutritionPanel);

export function nutritionPanel(userId) {
  const panel = document.createElement('wedx-nutrition');
  panel.ownerId = userId;
  return panel;
}
