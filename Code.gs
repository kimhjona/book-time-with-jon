/* Book Time with Jon - booking backend.
   Deploy as a Web App: "Execute as" = Me, "Who has access" = Anyone.
   The public page calls: GET ?action=book&name=..&email=..&start=..&duration=..&type=..&callback=..
   `start` must be ISO 8601 with a numeric UTC offset, e.g. 2026-09-27T18:00:00-07:00. */

var CONFIG = {
  HOST_EMAIL: 'kimhjona@gmail.com',
  HOST_NAME: 'Jon Kim',
  TIME_ZONE: 'America/Los_Angeles',
  ALLOWED_DAYS: [7, 2],            // ISO day numbers: 7 = Sunday, 2 = Tuesday
  ALLOWED_START_HOURS: [18, 19, 20], // 6, 7, 8 PM PT
  ALLOWED_DURATIONS: [30, 45, 60],
  MAX_DAYS_OUT: 7,
  LATEST_END_MINUTES: 21 * 60      // bookings must end by 9:00 PM PT
};

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out = (p.action === 'book') ? bookSlot(p)
          : (p.action === 'availability') ? availability()
          : { ok: true, service: 'book-time-with-jon' };
  var json = JSON.stringify(out);
  var cb = p.callback || p.jsonp;
  if (cb && /^[A-Za-z_$][\w$]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
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

  if (CONFIG.ALLOWED_DAYS.indexOf(dayNum) === -1 ||
      CONFIG.ALLOWED_START_HOURS.indexOf(hour) === -1) {
    return fail('Bookings are only open Sunday and Tuesday, 6:00-8:00 PM PT.');
  }
  if (start <= now || start > maxDate) {
    return fail('Please pick a slot within the next 7 days.');
  }
  if (endMinutes > CONFIG.LATEST_END_MINUTES) {
    return fail('Bookings must end by 9:00 PM PT.');
  }

  var cal = CalendarApp.getDefaultCalendar();
  if (cal.getEvents(start, end).length > 0) {
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

  return { ok: true, slot: slotLabel };
}

function fail(message) {
  return { ok: false, error: message };
}

// Epoch millis (UTC) of taken candidate slots, so the page can hide them.
function availability() {
  var tz = CONFIG.TIME_ZONE;
  var now = new Date();
  var cal = CalendarApp.getDefaultCalendar();
  var taken = [];
  for (var d = 1; d <= CONFIG.MAX_DAYS_OUT; d++) {
    var probe = new Date(now.getTime() + d * 24 * 60 * 60000);
    var dayNum = parseInt(Utilities.formatDate(probe, tz, 'u'), 10);
    if (CONFIG.ALLOWED_DAYS.indexOf(dayNum) === -1) continue;
    var y = parseInt(Utilities.formatDate(probe, tz, 'yyyy'), 10);
    var m = parseInt(Utilities.formatDate(probe, tz, 'MM'), 10);
    var dd = parseInt(Utilities.formatDate(probe, tz, 'dd'), 10);
    for (var i = 0; i < CONFIG.ALLOWED_START_HOURS.length; i++) {
      var start = ptInstant(y, m, dd, CONFIG.ALLOWED_START_HOURS[i], 0, tz);
      if (!start || start <= now) continue;
      // Use the longest allowed slot as the probe window so a 60-minute
      // booking hides the following hour, matching bookSlot's check.
      var end = new Date(start.getTime() + 60 * 60000);
      if (cal.getEvents(start, end).length > 0) {
        taken.push(start.getTime());
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
