/* Book Time with Jon - booking backend. Version 3, 2026-11-08.
   Deploy as a Web App: "Execute as" = Me, "Who has access" = Anyone.
   The public page calls: GET ?action=book&name=..&email=..&start=..&duration=..&type=..&callback=..
   `start` must be ISO 8601 with a numeric UTC offset, e.g. 2026-11-08T13:00:00-08:00.
   Deployed exec URL (unchanged across versions):
   https://script.google.com/macros/s/AKfycby4tNBPKsq9Rwrh5hAwsFupy8OXth0E2ifczo4Fdx485rnrYj1GO-sJVA4l1bZDoaS5/exec
   Apps Script project in Drive: "Book Time with Jon",
   scriptId 15ob9sVQgFNBADdn44qLXoCUSRT7jgbdxvGq1G8VRVGNHomp2KvzfBMmy
   To deploy: paste this file into the Apps Script editor, then
   Deploy > New deployment (or Manage deployments > edit) as a new version.
   The exec URL stays the same. */

var CONFIG = {
  HOST_EMAIL: 'kimhjona@gmail.com',
  HOST_NAME: 'Jon Kim',
  TIME_ZONE: 'America/Los_Angeles',
  ALLOWED_DAYS: [7, 2],            // ISO day numbers: 7 = Sunday, 2 = Tuesday
  ALLOWED_START_HOURS: [18, 19, 20], // 6, 7, 8 PM PT (regular recurring slots)
  ALLOWED_DURATIONS: [30, 45, 60],
  MAX_DAYS_OUT: 7,
  LATEST_END_MINUTES: 21 * 60      // bookings must end by 9:00 PM PT
};

// One-off offered slots for the week of Nov 8, 2026 (Pacific wall clock).
// Sunday Nov 8: 1, 2, 3, 4 and 7 PM. Tuesday Nov 10: 6, 7 and 8 PM.
// These are in addition to the regular Sunday/Tuesday 6-8 PM rule.
var SPECIAL_SLOTS = [
  { y: 2026, m: 11, d: 8,  h: 13 },
  { y: 2026, m: 11, d: 8,  h: 14 },
  { y: 2026, m: 11, d: 8,  h: 15 },
  { y: 2026, m: 11, d: 8,  h: 16 },
  { y: 2026, m: 11, d: 8,  h: 19 },
  { y: 2026, m: 11, d: 10, h: 18 },
  { y: 2026, m: 11, d: 10, h: 19 },
  { y: 2026, m: 11, d: 10, h: 20 }
];

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out = (p.action === 'book') ? bookSlot(p)
          : (p.action === 'availability') ? availability()
          : (p.action === 'notify') ? notifyBooked(p)
          : { ok: true, service: 'book-time-with-jon' };
  var json = JSON.stringify(out);
  var cb = p.callback || p.jsonp;
  if (cb && /^[A-Za-z_$][\w$]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function specialSlotInstants(tz) {
  var out = [];
  for (var i = 0; i < SPECIAL_SLOTS.length; i++) {
    var s = SPECIAL_SLOTS[i];
    var t = ptInstant(s.y, s.m, s.d, s.h, 0, tz);
    if (t) out.push(t);
  }
  return out;
}

function isSpecialSlot(start, tz) {
  var specials = specialSlotInstants(tz);
  for (var i = 0; i < specials.length; i++) {
    if (specials[i].getTime() === start.getTime()) return true;
  }
  return false;
}

// Every candidate slot the page may offer: the special one-off slots plus
// the regular Sunday/Tuesday 6-8 PM slots for today through 7 days out.
function candidateSlots(tz, now) {
  var slots = [];
  var seen = {};
  function add(t) {
    if (!t || t <= now) return;
    var key = String(t.getTime());
    if (!seen[key]) { seen[key] = true; slots.push(t); }
  }
  var specials = specialSlotInstants(tz);
  for (var i = 0; i < specials.length; i++) add(specials[i]);
  for (var d = 0; d <= CONFIG.MAX_DAYS_OUT; d++) {
    var probe = new Date(now.getTime() + d * 24 * 60 * 60000);
    var dayNum = parseInt(Utilities.formatDate(probe, tz, 'u'), 10);
    if (CONFIG.ALLOWED_DAYS.indexOf(dayNum) === -1) continue;
    var y = parseInt(Utilities.formatDate(probe, tz, 'yyyy'), 10);
    var m = parseInt(Utilities.formatDate(probe, tz, 'MM'), 10);
    var dd = parseInt(Utilities.formatDate(probe, tz, 'dd'), 10);
    for (var j = 0; j < CONFIG.ALLOWED_START_HOURS.length; j++) {
      add(ptInstant(y, m, dd, CONFIG.ALLOWED_START_HOURS[j], 0, tz));
    }
  }
  return slots;
}

function bookSlot(p) {
  var name = String(p.name || '').trim();
  var email = String(p.email || '').trim().toLowerCase();
  var startIso = String(p.start || '').trim();
  var duration = parseInt(p.duration, 10);
  var meetingType = String(p.type || 'facetime').toLowerCase();

  if (!name) return fail('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address.');
  if (CONFIG.ALLOWED_DURATIONS.indexOf(duration) === -1) return fail('Please choose a valid length.');
  if (meetingType !== 'meet') meetingType = 'facetime';

  var start = new Date(startIso);
  if (isNaN(start.getTime())) return fail('Please pick a valid time slot.');

  var tz = CONFIG.TIME_ZONE;
  var dayNum = parseInt(Utilities.formatDate(start, tz, 'u'), 10); // 1=Mon .. 7=Sun
  var hour = parseInt(Utilities.formatDate(start, tz, 'H'), 10);
  var end = new Date(start.getTime() + duration * 60000);
  var endMinutes = parseInt(Utilities.formatDate(end, tz, 'H'), 10) * 60 +
                   parseInt(Utilities.formatDate(end, tz, 'm'), 10);

  var now = new Date();
  var maxDate = new Date(now.getTime() + CONFIG.MAX_DAYS_OUT * 24 * 60 * 60000);

  var isSpecial = isSpecialSlot(start, tz);
  var isRegular = CONFIG.ALLOWED_DAYS.indexOf(dayNum) !== -1 &&
                  CONFIG.ALLOWED_START_HOURS.indexOf(hour) !== -1;
  if (!isSpecial && !isRegular) {
    return fail('Bookings are only open Sunday and Tuesday, 6:00-8:00 PM PT, plus Sunday Nov 8 at 1, 2, 3 and 4 PM PT.');
  }
  if (start <= now || start > maxDate) {
    return fail('Please pick a slot within the next 7 days.');
  }
  if (endMinutes > CONFIG.LATEST_END_MINUTES) {
    return fail('Bookings must end by 9:00 PM PT.');
  }

  var cal = CalendarApp.getDefaultCalendar();
  if (hasNonAllDayConflict(cal, start, end)) {
    return fail('That slot was just taken. Please pick another time.');
  }

  var slotLabel = Utilities.formatDate(start, tz, "EEEE, MMM d 'at' h:mm a") + ' PT';
  var where = (meetingType === 'meet') ? 'Google Meet' : 'FaceTime (Jon calls)';

  cal.createEvent('Time with Jon: ' + name, start, end, {
    description: 'Booked via the booking page.\n' +
                 'Guest: ' + name + ' <' + email + '>\n' +
                 'Length: ' + duration + ' min\n' +
                 'Where: ' + where,
    guests: email,
    sendInvites: true
  });

  // The calendar event is created before responding so the page stays fast.
  // Confirmation emails go out via ?action=notify right after.
  return { ok: true, slot: slotLabel };
}

// Sends the confirmation emails after the booking. Guarded: only fires when
// a matching calendar event actually exists, so it cannot be abused to send
// email on its own.
function notifyBooked(p) {
  var name = String(p.name || '').trim();
  var email = String(p.email || '').trim().toLowerCase();
  var start = new Date(String(p.start || '').trim());
  var duration = parseInt(p.duration, 10);
  var meetingType = String(p.type || 'facetime').toLowerCase();

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || isNaN(start.getTime())) {
    return { ok: false };
  }
  if (CONFIG.ALLOWED_DURATIONS.indexOf(duration) === -1) return { ok: false };
  if (meetingType !== 'meet') meetingType = 'facetime';

  var end = new Date(start.getTime() + duration * 60000);
  var events = CalendarApp.getDefaultCalendar().getEvents(start, end);
  var found = false;
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.getTitle() === 'Time with Jon: ' + name &&
        (ev.getDescription() || '').indexOf(email) !== -1) {
      found = true;
      break;
    }
  }
  if (!found) return { ok: false };

  var tz = CONFIG.TIME_ZONE;
  var slotLabel = Utilities.formatDate(start, tz, "EEEE, MMM d 'at' h:mm a") + ' PT';
  var whereLine = (meetingType === 'meet')
    ? 'Google Meet link will be in the calendar invite.'
    : 'FaceTime. Jon will call you.';
  var body = 'Hi ' + name + ',\n\n' +
    'You are booked for ' + slotLabel + ' (' + duration + ' min).\n' +
    whereLine + '\n\n' +
    'A calendar invite is on its way to ' + email + '.\n\n' +
    'Looking forward to it!\nJon';

  GmailApp.sendEmail(CONFIG.HOST_EMAIL, 'Booked: Time with Jon, ' + slotLabel, body,
    { cc: email, name: CONFIG.HOST_NAME });

  return { ok: true };
}

function fail(message) {
  return { ok: false, error: message };
}

// True if a real (non-all-day) event overlaps [start, end). All-day events
// like birthdays and holidays are ignored on purpose: a whole-day block
// should not swallow the evening slots.
function hasNonAllDayConflict(cal, start, end) {
  var events = cal.getEvents(start, end);
  for (var i = 0; i < events.length; i++) {
    if (!events[i].isAllDayEvent()) return true;
  }
  return false;
}

// Epoch millis (UTC) of taken candidate slots, so the page can hide them.
// Uses a single calendar query for the whole week, then checks overlaps
// locally, so the page loads fast.
function availability() {
  var tz = CONFIG.TIME_ZONE;
  var now = new Date();
  var weekEnd = new Date(now.getTime() + CONFIG.MAX_DAYS_OUT * 24 * 60 * 60000);
  var cal = CalendarApp.getDefaultCalendar();
  var events = cal.getEvents(now, weekEnd); // one call, not one per slot

  var slots = candidateSlots(tz, now);

  var taken = [];
  for (var s = 0; s < slots.length; s++) {
    var start = slots[s];
    // Use the longest allowed slot as the probe window so a 60-minute
    // booking hides the following hour, matching bookSlot's check.
    var end = new Date(start.getTime() + 60 * 60000);
    for (var j = 0; j < events.length; j++) {
      var ev = events[j];
      // All-day events are skipped: they should not swallow evening slots.
      if (!ev.isAllDayEvent() && ev.getStartTime() < end && ev.getEndTime() > start) {
        taken.push(start.getTime());
        break;
      }
    }
  }
  return { ok: true, taken: taken };
}

// Build a Date for a Pacific wall-clock time, verified by round trip.
function ptInstant(y, m, d, hour, minute, tz) {
  var guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  var offStr = Utilities.formatDate(new Date(guess), tz, 'Z'); // e.g. -0700
  var sign = offStr.charAt(0) === '-' ? -1 : 1;
  var offMin = sign * (parseInt(offStr.substr(1, 2), 10) * 60 +
                       parseInt(offStr.substr(3, 2), 10));
  var t = new Date(guess - offMin * 60000);
  var expect = y + pad2(m) + pad2(d) + pad2(hour) + pad2(minute);
  if (Utilities.formatDate(t, tz, 'yyyyMMddHHmm') !== expect) return null;
  return t;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}
