// Replaced with the deployed Google Apps Script web app URL at deploy time.
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby4tNBPKsq9Rwrh5hAwsFupy8OXth0E2ifczo4Fdx485rnrYj1GO-sJVA4l1bZDoaS5/exec';

const TZ = 'America/Los_Angeles';
const SLOT_HOURS = [18, 19, 20]; // 6, 7, 8 PM PT
const BOOK_TIMEOUT_MS = 25000;   // event creation only; email follows in the background
const AVAIL_TIMEOUT_MS = 25000;

// ---------- Pacific-time helpers (DST-safe, no hardcoded offset) ----------

// Numeric offset of America/Los_Angeles, in minutes, at a given UTC instant.
function laOffsetMinutes(instant) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = dtf.formatToParts(instant);
  const get = t => parts.find(p => p.type === t).value;
  const laAsUTC = Date.UTC(
    +get('year'), +get('month') - 1, +get('day'),
    +get('hour'), +get('minute'), +get('second')
  );
  return (laAsUTC - instant.getTime()) / 60000;
}

// Convert a Pacific wall-clock time (y, m, d, hour, minute) to a Date instant.
function ptWallToInstant(y, m, d, hour, minute) {
  const wallUTC = Date.UTC(y, m - 1, d, hour, minute);
  let t = wallUTC;
  for (let i = 0; i < 3; i++) {
    const corrected = wallUTC - laOffsetMinutes(new Date(t)) * 60000;
    if (corrected === t) break;
    t = corrected;
  }
  return new Date(t);
}

// Format an instant as ISO 8601 with the numeric Pacific offset, e.g.
// 2026-09-27T18:00:00-07:00
function formatISOWithOffset(instant) {
  const off = laOffsetMinutes(instant);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = dtf.formatToParts(instant);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${sign}${hh}:${mm}`;
}

// ---------- Slot computation ----------

// The nearest upcoming weekday strictly after today, within the next 7 days.
function nextWeekday(weekday) {
  const now = new Date();
  for (let d = 1; d <= 7; d++) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    if (dt.getDay() === weekday) return dt;
  }
  return null;
}

const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric'
});

function hourLabel(hour24) {
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h}:00 PM`;
}

function slotFor(date, hour) {
  const instant = ptWallToInstant(date.getFullYear(), date.getMonth() + 1, date.getDate(), hour, 0);
  return { iso: formatISOWithOffset(instant), display: hourLabel(hour), epoch: instant.getTime() };
}

// ---------- JSONP ----------

function jsonp(action, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cb = 'jonBookCb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }

    window[cb] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('network')); };

    const qs = Object.entries(params)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    script.src = SCRIPT_URL + '?action=' + encodeURIComponent(action) + '&' + qs + '&callback=' + encodeURIComponent(cb);
    document.body.appendChild(script);
  });
}

// ---------- UI state ----------

const form = document.getElementById('booking-form');
const slotGroups = document.getElementById('slot-groups');
const nameInput = document.getElementById('name');
const emailInput = document.getElementById('email');
const confirmBtn = document.getElementById('confirm-btn');
const errorBox = document.getElementById('error');
const confirmation = document.getElementById('confirmation');
const confirmationSlot = document.getElementById('confirmation-slot');

let selectedSlot = null;
let duration = 60;
let meetType = 'facetime';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function renderSlots(takenEpochs) {
  const taken = new Set(takenEpochs || []);
  let shown = 0;

  [0, 2].forEach(weekday => { // Sunday, Tuesday
    const date = nextWeekday(weekday);
    if (!date) return;
    const free = SLOT_HOURS
      .map(hour => slotFor(date, hour))
      .filter(slot => !taken.has(slot.epoch));
    if (free.length === 0) return; // day fully booked: do not show it

    const group = document.createElement('div');
    group.className = 'day-group';

    const heading = document.createElement('h3');
    heading.textContent = dayFmt.format(date);
    group.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'slot-row';

    free.forEach(slot => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.textContent = slot.display;
      btn.addEventListener('click', () => selectSlot(btn, slot));
      row.appendChild(btn);
      shown++;
    });

    group.appendChild(row);
    slotGroups.appendChild(group);
  });

  if (shown === 0) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'No open times this week. Check back soon.';
    slotGroups.appendChild(note);
  }
}

function selectSlot(btn, slot) {
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedSlot = slot;
  updateConfirmState();
}

function wireChoiceButtons(containerId, selector, onSelect) {
  const container = document.getElementById(containerId);
  container.querySelectorAll(selector).forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll(selector).forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(btn);
    });
  });
}

function updateConfirmState() {
  const ok = Boolean(selectedSlot)
    && nameInput.value.trim().length > 0
    && EMAIL_RE.test(emailInput.value.trim());
  confirmBtn.disabled = !ok;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}

async function handleSubmit(e) {
  e.preventDefault();
  if (confirmBtn.disabled) return;

  hideError();
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Booking...';

  try {
    const guestName = nameInput.value.trim();
    const guestEmail = emailInput.value.trim();
    const data = await jsonp('book', {
      name: guestName,
      email: guestEmail,
      start: selectedSlot.iso,
      duration: String(duration),
      type: meetType
    }, BOOK_TIMEOUT_MS);

    if (data && data.ok) {
      confirmationSlot.textContent = (data.slot || '') + ' (' + duration + ' min)';
      form.hidden = true;
      confirmation.hidden = false;
      window.scrollTo(0, 0);
      // Confirmation emails go out in the background; do not block the page.
      jsonp('notify', {
        name: guestName,
        email: guestEmail,
        start: selectedSlot.iso,
        duration: String(duration),
        type: meetType
      }, AVAIL_TIMEOUT_MS).catch(() => {});
    } else {
      showError((data && data.error) || 'Something went wrong. Try again.');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
    }
  } catch (err) {
    showError(err && err.message === 'timeout'
      ? 'That took too long. Try again.'
      : 'Could not reach the booking service. Try again.');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm';
  }
}

async function init() {
  slotGroups.innerHTML = '<p class="hint">Checking open times...</p>';
  let taken = [];
  try {
    const data = await jsonp('availability', {}, AVAIL_TIMEOUT_MS);
    if (data && data.ok && Array.isArray(data.taken)) taken = data.taken;
  } catch (err) {
    // Fall back to showing everything; the backend still rejects
    // double bookings at confirm time.
  }
  slotGroups.innerHTML = '';
  renderSlots(taken);
}

init();

wireChoiceButtons('duration-pills', '.pill', btn => {
  duration = parseInt(btn.dataset.duration, 10);
});

document.querySelector('.meet-options').querySelectorAll('.meet-option').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.meet-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    meetType = btn.dataset.type;
  });
});

nameInput.addEventListener('input', updateConfirmState);
emailInput.addEventListener('input', updateConfirmState);
form.addEventListener('submit', handleSubmit);
updateConfirmState();
