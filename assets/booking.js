const FREE_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.co.in',
  'hotmail.com','hotmail.co.uk','outlook.com','live.com','msn.com',
  'icloud.com','me.com','mac.com','aol.com','protonmail.com','proton.me',
  'gmx.com','gmx.de','mail.com','yandex.com','yandex.ru','zoho.com',
  'tutanota.com','fastmail.com','hey.com','duck.com','pm.me'
]);

const API_BASE = 'http://localhost:8000';

let groupedSlots = {};
let timezone = '';

function isBusinessEmail(email) {
  const m = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(email.trim().toLowerCase());
  if (!m) return false;
  return !FREE_DOMAINS.has(m[1]);
}

function fmtDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return {
    day: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    num: d.getDate(),
    mon: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
  };
}

function fmtTime(isoDateTime) {
  const t = new Date(isoDateTime);
  return t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtFull(isoDateTime) {
  const t = new Date(isoDateTime);
  return t.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

async function loadAvailability() {
  const pickers = document.querySelectorAll('[data-picker]');
  if (pickers.length === 0) return;

  try {
    const r = await fetch(`${API_BASE}/api/availability`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const data = await r.json();
    timezone = data.timezone;

    groupedSlots = {};
    for (const iso of data.slots) {
      const date = iso.slice(0, 10);
      (groupedSlots[date] = groupedSlots[date] || []).push(iso);
    }

    pickers.forEach(renderPicker);
  } catch (e) {
    console.error('[MutexOps] availability fetch failed', e);
    pickers.forEach(p => {
      p.innerHTML = '<div class="picker-empty">Couldn\'t load times. Email <a href="mailto:anesh@mutexops.com">anesh@mutexops.com</a> and we\'ll book you in.</div>';
    });
  }
}

function renderPicker(pickerEl) {
  const dates = Object.keys(groupedSlots).sort();
  if (dates.length === 0) {
    pickerEl.innerHTML = '<div class="picker-empty">No availability in the next 14 days. Please email anesh@mutexops.com.</div>';
    return;
  }

  const tzPretty = timezone.replace(/_/g, ' ');
  pickerEl.innerHTML = `
    <div class="picker-tz">All times in ${tzPretty}</div>
    <div class="date-strip" data-role="dates">
      ${dates.map((d, i) => {
        const f = fmtDate(d);
        return `<button type="button" class="date-pill${i === 0 ? ' active' : ''}" data-date="${d}">
          <div class="day">${f.day}</div>
          <div class="num">${f.num}</div>
          <div class="mon">${f.mon}</div>
        </button>`;
      }).join('')}
    </div>
    <div class="time-chips" data-role="times"></div>
  `;

  const timesEl = pickerEl.querySelector('[data-role="times"]');
  const renderTimes = (date) => {
    timesEl.innerHTML = groupedSlots[date].map(iso =>
      `<button type="button" class="time-chip" data-slot="${iso}">${fmtTime(iso)}</button>`
    ).join('');
  };

  pickerEl.querySelectorAll('.date-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      pickerEl.querySelectorAll('.date-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTimes(btn.dataset.date);
      const slotInput = pickerEl.closest('[data-card]').querySelector('[data-slot]');
      if (slotInput) slotInput.value = '';
    });
  });

  timesEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.time-chip');
    if (!chip) return;
    timesEl.querySelectorAll('.time-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const card = pickerEl.closest('[data-card]');
    card.querySelector('[data-slot]').value = chip.dataset.slot;
    const errorEl = card.querySelector('[data-error]');
    if (errorEl) errorEl.classList.remove('visible');
  });

  renderTimes(dates[0]);
}

async function submitDemo(event, formId) {
  event.preventDefault();
  const form = document.getElementById(formId);
  const card = form.closest('[data-card]');
  const emailInput = form.querySelector('input[type="email"]');
  const companyInput = form.querySelector('input[name="company"]');
  const slotInput = form.querySelector('[data-slot]');
  const errorEl = card.querySelector('[data-error]');
  const successEl = card.querySelector('[data-success]');
  const submitBtn = form.querySelector('.submit-btn');

  const email = emailInput.value.trim();
  const company = companyInput.value.trim();
  const slot = slotInput ? slotInput.value : '';

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
  };
  errorEl.classList.remove('visible');
  errorEl.textContent = '';

  if (!isBusinessEmail(email)) {
    showError("Please use your business email — free providers aren't supported.");
    emailInput.focus();
    return false;
  }
  if (!company) {
    showError('Company is required.');
    companyInput.focus();
    return false;
  }
  if (!slot) {
    showError('Please pick a date and time above.');
    return false;
  }

  const origLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Booking…';

  const interest = form.dataset.interest || '';

  try {
    const r = await fetch(`${API_BASE}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, company, slot, interest })
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(result.detail || `Booking failed (${r.status})`);
    }

    successEl.innerHTML = `
      <div style="font-weight:600; margin-bottom:8px;">✓ Request received.</div>
      <div>We'll send a Teams invite to <strong>${email}</strong> shortly.</div>
      <div style="margin-top:8px; font-family: var(--font-mono); font-size: 0.78rem;">${fmtFull(result.booked_for)} · ${result.timezone.replace(/_/g, ' ')}</div>
    `;
    successEl.classList.add('visible');
    card.classList.add('booked');
  } catch (e) {
    showError(e.message || 'Booking failed. Please try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = origLabel;
  }
  return false;
}

document.addEventListener('DOMContentLoaded', loadAvailability);

function toggleFaq(el) {
  const item = el.parentElement;
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(i => {
    i.classList.remove('open');
    i.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
  });
  if (!wasOpen) {
    item.classList.add('open');
    el.setAttribute('aria-expanded', 'true');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.faq-q').forEach(q => {
    q.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFaq(q); }
    });
  });

  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
  }
});
