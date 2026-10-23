import { nutritionStatus } from './metrics.js';

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function monthCells(month) {
  const first = new Date(`${month}-01T12:00:00`);
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = Array((first.getDay() + 6) % 7).fill(null);
  for (let i = 1; i <= count; i++) cells.push(`${month}-${String(i).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}
const text = (tag, value, className) => {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className; return node;
};

export function nutritionCalendar({ metrics, month, selectedDate, today, onSelect, onMonth }) {
  const calendar = document.createElement('section'); calendar.className = 'nutrition-calendar';
  calendar.setAttribute('aria-label', 'Календарь питания');
  const months = [...new Set([...metrics.keys()].map(date => date.slice(0, 7)))].sort();
  const index = months.indexOf(month);
  const header = document.createElement('div'); header.className = 'nutrition-calendar-header';
  const title = text('strong', new Date(`${month}-01T12:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }));
  function move(label, symbol, offset) {
    const button = text('button', symbol); button.type = 'button'; button.setAttribute('aria-label', label);
    button.dataset.calendarFocus = String(offset); button.disabled = !months[index + offset];
    button.onclick = () => onMonth(months[index + offset]); return button;
  }
  header.append(move('Предыдущий месяц', '‹', -1), title, move('Следующий месяц', '›', 1));
  const weekdays = document.createElement('div'); weekdays.className = 'nutrition-weekdays'; weekdays.setAttribute('aria-hidden', 'true');
  for (const name of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']) weekdays.append(text('span', name));
  const grid = document.createElement('div'); grid.className = 'nutrition-calendar-grid';
  for (const date of monthCells(month)) {
    if (!date) { grid.append(document.createElement('span')); continue; }
    const m = metrics.get(date), status = m ? nutritionStatus(m, today) : null;
    const cell = text('button', ''); cell.type = 'button'; cell.dataset.date = date; cell.dataset.calendarFocus = date;
    cell.className = `nutrition-calendar-day ${status?.kind || 'empty'}`;
    const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    cell.setAttribute('aria-label', `${dateLabel} · ${status?.label || 'Нет данных'}${status?.over && status.lowProtein ? ', мало белка' : ''}`);
    cell.setAttribute('aria-pressed', String(date === selectedDate));
    if (date === today) cell.setAttribute('aria-current', 'date');
    cell.disabled = !m || date > today;
    cell.append(text('span', String(Number(date.slice(-2))), 'calendar-number'));
    const marks = text('span', '', 'calendar-marks'); marks.setAttribute('aria-hidden', 'true');
    if (status?.over) marks.append(text('i', '+', 'calorie-mark'));
    if (status?.lowProtein) marks.append(text('i', 'Б', 'protein-mark'));
    if (status?.kind === 'met') marks.append(text('i', '✓'));
    if (status?.kind === 'pending') marks.append(text('i', '·'));
    if (status?.kind === 'unknown') marks.append(text('i', '—'));
    cell.append(marks); cell.onclick = () => onSelect(date); grid.append(cell);
  }
  const legend = document.createElement('div'); legend.className = 'nutrition-calendar-legend';
  for (const [kind, label] of [['met', '✓ В норме'], ['over', '+ Перебор'], ['protein', 'Б Мало белка']]) legend.append(text('span', label, kind));
  calendar.append(header, weekdays, grid, legend); return calendar;
}
