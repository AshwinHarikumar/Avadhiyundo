/* ══════════════════════════════════════════════════════════════════
   അവധിയുണ്ടോ? — Kerala Rain Holiday Watch

   Renders window.KERALA_STATUS into the departure board. Nothing here
   invents a verdict: every classification below is read off the data.
══════════════════════════════════════════════════════════════════ */

/* ── Theme: night is the default, because the reader is in bed ── */
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem("krhw-theme"); } catch (e) { /* private mode */ }
  if (saved === "day") root.setAttribute("data-theme", "day");
})();

(function () {
  "use strict";

  var IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  function $(id) { return document.getElementById(id); }

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Only http(s) links are ever emitted into an href. */
  function safeUrl(u) {
    if (!u) return null;
    try {
      var p = new URL(String(u), document.baseURI);
      return (p.protocol === "http:" || p.protocol === "https:") ? p.href : null;
    } catch (e) { return null; }
  }

  /* Today in IST, as YYYY-MM-DD, regardless of the reader's own zone. */
  function istDateStr(offsetDays) {
    var t = Date.now() + IST_OFFSET_MS + (offsetDays || 0) * 864e5;
    return new Date(t).toISOString().slice(0, 10);
  }

  var ICON = {
    declared: '<svg class="verdict-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
    partial: '<svg class="verdict-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="9"/></svg>',
    unconfirmed: '<svg class="verdict-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><path d="M12 17.5v.01"/><circle cx="12" cy="12" r="9"/></svg>',
    none: '<svg class="verdict-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
    debunked: '<svg class="verdict-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    src: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
  };

  /* ── Classification. Read from the data, never inferred. ──
     A confirmed district is *partial* when the order covers only a subset:
     relief-camp schools, or named taluks. PRODUCT.md: partial is derived
     from scope/appliesTo, it is not a status of its own. */
  function isPartial(d) {
    if (d.status !== "confirmed") return false;
    var s = ((d.scope || "") + " " + (d.appliesTo || "")).toLowerCase();
    return s.indexOf("relief") > -1 || s.indexOf("taluk") > -1;
  }

  function kindOf(d) {
    if (d.status === "confirmed") return isPartial(d) ? "partial" : "declared";
    if (d.status === "unconfirmed") return "unconfirmed";
    if (d.status === "false") return "debunked";
    return "none";
  }

  var VERDICT_LABEL = {
    declared: "Holiday",
    partial: "Partial",
    unconfirmed: "Unconfirmed",
    none: "No declaration",
    debunked: "Debunked"
  };

  /* Pull taluk names out of a prose scope line. Returns [] when the scope
     is not taluk-shaped, so district-wide orders never grow chips. */
  function parseTaluks(scope) {
    if (!scope || scope.toLowerCase().indexOf("taluk") === -1) return [];
    var tail = scope.replace(/^.*?\bin\b/i, "");
    if (tail === scope) tail = scope;
    return tail
      .replace(/educational institutions?/gi, "")
      .replace(/\btaluks?\b/gi, "")
      .replace(/\bonly\b/gi, "")
      .replace(/\bfor\b/gi, "")
      .replace(/\bin\b/gi, "")
      .split(/,|\band\b/i)
      .map(function (s) { return s.replace(/[.\s]+$/, "").trim(); })
      .filter(function (s) { return s.length > 1 && s.length < 40; });
  }

  /* ── Storage. Private mode must degrade silently, never throw. ── */
  function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { /* private mode */ }
    return null;
  }

  function writeStore(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode */ }
  }

  /* Coarse on purpose: "22 min ago" is actionable, "22m 31s" is noise. */
  function agoText(iso) {
    var then = new Date(iso);
    if (isNaN(then)) return null;
    var mins = Math.floor((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs === 1 ? "1 hour ago" : hrs + " hours ago";
    var days = Math.floor(hrs / 24);
    return days === 1 ? "1 day ago" : days + " days ago";
  }

  /* ── Offline shell. Registered before the data guard below, which returns
     out of this IIFE and would otherwise skip it. ── */
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* offline is a bonus, not a requirement */ });
    });
  }

  /* ═════════════════ render ═════════════════ */

  var data = window.KERALA_STATUS;
  var history = window.KERALA_HISTORY || null;

  if (!data || !Array.isArray(data.districts)) {
    var main = $("main");
    if (main) {
      main.innerHTML =
        '<div class="shell board-wrap"><p class="board-empty">' +
        "District data could not be loaded. Reload the page, and if it stays empty, " +
        "check the Collector's own announcement for your district." +
        "</p></div>";
    }
    return;
  }

  var districts = data.districts;
  var kinds = districts.map(kindOf);
  var count = function (k) {
    return kinds.filter(function (x) { return x === k; }).length;
  };

  var nDeclared = count("declared");
  var nPartial = count("partial");
  var nUnconfirmed = count("unconfirmed");
  var nNone = count("none") + count("debunked");
  var total = districts.length;

  /* ── Stale guard. An old page is dangerous, so it says so loudly.
     Three distinct messages share this slot — the expired-date case below,
     the age/offline case, and the re-check failure at the foot of this file.
     Only a genuinely expired date earns `is-stale`, which recolours the lamp. ── */
  function renderGuard() {
    var el = $("staleGuard");
    if (!el || !data.forDate) return;

    if (istDateStr(0) > data.forDate) {
      el.innerHTML =
        "This page is out of date. It shows <strong>" + esc(data.forDateLabel || data.forDate) +
        "</strong>, which has already passed — check your District Collector for tonight.";
      el.hidden = false;
      document.body.classList.add("is-stale");
      return;
    }

    var offline = navigator.onLine === false;
    var checked = new Date(data.checkedAt);
    var oldCheck = !isNaN(checked) && (Date.now() - checked.getTime()) > 3 * 3600 * 1000;

    if (!offline && !oldCheck) { el.hidden = true; return; }

    var age = data.checkedAt ? agoText(data.checkedAt) : null;
    el.innerHTML = (offline ? "You are offline. " : "") +
      "This is the last answer that reached your phone" +
      (age ? ", checked <strong>" + esc(age) + "</strong>" : "") +
      ". Collectors may have announced since — check your District Collector before acting on it.";
    el.hidden = false;
  }

  renderGuard();

  /* Signal can die mid-evening in heavy rain; the notice must appear then too. */
  window.addEventListener("offline", renderGuard);
  window.addEventListener("online", renderGuard);

  /* ── Masthead stamp ── */
  (function () {
    var el = $("stamp");
    if (!el || !data.checkedAt) return;
    var d = new Date(data.checkedAt);
    if (isNaN(d)) { el.textContent = "Checked " + data.checkedAt; return; }
    var time = new Intl.DateTimeFormat("en-IN", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata"
    }).format(d);
    var day = new Intl.DateTimeFormat("en-IN", {
      day: "numeric", month: "short", timeZone: "Asia/Kolkata"
    }).format(d);
    el.innerHTML = "Sources checked <b>" + esc(time) + "</b> IST · " + esc(day);
  })();

  /* ── The lamp: date, count, headline, tally ── */
  (function () {
    var rel = $("forDateRel");
    if (rel && data.forDate) {
      var today = istDateStr(0);
      rel.textContent =
        data.forDate < today ? "Expired" :
        data.forDate === today ? "Today" :
        data.forDate === istDateStr(1) ? "Tomorrow" : "Upcoming";
    }

    var full = $("forDate");
    if (full) full.textContent = data.forDateLabel || data.forDate || "";

    var withHoliday = nDeclared + nPartial;
    var countEl = $("lampCount");
    var ofEl = $("lampOf");
    if (countEl) countEl.textContent = String(withHoliday);
    if (ofEl) {
      ofEl.textContent = withHoliday === 1
        ? "of " + total + " districts has a holiday"
        : "of " + total + " districts have a holiday";
    }

    var head = $("headline");
    if (head) head.textContent = data.headline || "";

    var cells = [
      ["declared", nDeclared, "Full holiday"],
      ["partial", nPartial, "Partial only"],
      ["unconfirmed", nUnconfirmed, "Unconfirmed"],
      ["none", nNone, "No declaration"]
    ];
    var tally = $("tally");
    if (tally) {
      tally.innerHTML = cells.map(function (c) {
        return '<p class="split-cell sc-' + c[0] + '">' +
          '<strong class="split-n">' + c[1] + "</strong>" +
          '<span class="split-l">' + esc(c[2]) + "</span></p>";
      }).join("");
    }

    var caveat = $("caveat");
    if (caveat) {
      caveat.textContent = nPartial > 0
        ? "Partial districts are not a full holiday — the order covers only relief-camp schools or named taluks. Open the district for the exact wording."
        : "Collectors declare district by district, often late at night. A district reading no declaration tonight may still be declared before morning.";
    }
  })();

  /* ── The board ── */
  var boardRows = $("boardRows");
  var filtersEl = $("filters");
  var activeFilter = "all";

  var pinned = readStore("krhw-pin");
  if (pinned && !districts.some(function (d) { return d.name === pinned; })) pinned = null;

  /* Newest transition for a district within the current target date. Events
     from an earlier forDate describe a different night and are ignored. */
  function latestEvent(name) {
    if (!history || !Array.isArray(history.events)) return null;
    var found = null;
    for (var i = 0; i < history.events.length; i++) {
      var e = history.events[i];
      if (e.d === name && e.forDate === data.forDate) found = e;
    }
    return found;
  }

  var ORDER = { declared: 0, partial: 1, unconfirmed: 2, none: 3, debunked: 4 };

  var PIN_ON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.9 6.3 6.6.8-4.9 4.6 1.3 6.8L12 17.2 6.1 20.5l1.3-6.8L2.5 9.1l6.6-.8z"/></svg>';
  var PIN_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.9 6.3 6.6.8-4.9 4.6 1.3 6.8L12 17.2 6.1 20.5l1.3-6.8L2.5 9.1l6.6-.8z"/></svg>';

  function rowHtml(d) {
    var kind = kindOf(d);

    var alertMeta = {
      red: ["al-red", "Red alert"],
      orange: ["al-orange", "Orange alert"],
      yellow: ["al-yellow", "Yellow alert"]
    }[d.alert] || ["al-none", "No IMD alert"];

    var scope;
    if (kind === "declared") {
      scope = d.appliesTo || d.scope || "All educational institutions";
    } else if (kind === "partial") {
      scope = d.appliesTo || d.scope || "A subset of institutions only";
    } else if (kind === "unconfirmed") {
      scope = d.scope || "Reported, but no Collector's order confirmed.";
    } else if (kind === "debunked") {
      scope = d.reason || "Circulating claim, checked and found false.";
    } else {
      scope = "No closure order reported for this district.";
    }

    var meta = "";

    var taluks = parseTaluks(d.scope);
    if (taluks.length) {
      meta += '<span class="taluks">' + taluks.map(function (t) {
        return '<span class="taluk">' + esc(t) + "</span>";
      }).join("") + "</span>";
    }

    if (d.excludes) {
      meta += '<span class="meta-row m-exclude"><b>Excludes</b> ' + esc(d.excludes) + "</span>";
    }
    if (d.exams) {
      meta += '<span class="meta-row"><b>Exams</b> ' + esc(d.exams) + "</span>";
    }
    if (d.declaredBy) {
      meta += '<span class="meta-row"><b>Declared by</b> ' + esc(d.declaredBy) + "</span>";
    }
    if (kind === "unconfirmed" && d.confidenceNote) {
      meta += '<span class="meta-row"><b>Note</b> ' + esc(d.confidenceNote) + "</span>";
    }

    /* When this district changed tonight, say when. Observed, not inferred. */
    var ev = latestEvent(d.name);
    var when = ev && agoText(ev.at);
    if (when) {
      var moved = ev.to && ev.to.status === "confirmed" ? "Declared" : "Updated";
      meta += '<span class="meta-row m-when"><b>' + moved + "</b> " + esc(when) + "</span>";
    }

    var sources = (d.sources || []).map(function (s) {
      var href = safeUrl(s.url);
      if (!href) return "";
      return '<a class="src" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        ICON.src + "<span>" + esc(s.name || "Source") +
        '</span><span class="sr-only"> — opens in a new tab</span></a>';
    }).join("");

    var isPinned = pinned === d.name;
    var acts =
      '<span class="row-acts">' +
        '<button type="button" class="act act-pin" data-act="pin" aria-pressed="' + isPinned + '">' +
          (isPinned ? PIN_ON : PIN_OFF) +
          "<span>" + (isPinned ? "Pinned" : "Pin") + "</span>" +
          '<span class="sr-only"> ' + esc(d.name) + "</span>" +
        "</button>" +
      "</span>";

    return '<article class="row r-' + kind + (isPinned ? " is-pinned" : "") +
      '" data-name="' + esc(d.name) + '">' +
      '<h3 class="row-name">' + esc(d.name) +
        (isPinned ? '<span class="pin-flag">Pinned</span>' : "") +
        '<span class="row-alert ' + alertMeta[0] + '">' +
          '<span class="alert-dot" aria-hidden="true"></span>' + esc(alertMeta[1]) +
        "</span>" +
      "</h3>" +
      '<p class="row-verdict v-' + kind + '">' + ICON[kind] + VERDICT_LABEL[kind] + "</p>" +
      '<div class="row-scope">' +
        '<p class="scope-line">' + esc(scope) + "</p>" +
        (meta ? '<span class="scope-meta">' + meta + "</span>" : "") +
        sources +
        acts +
      "</div>" +
    "</article>";
  }

  var searchQuery = "";

  function matchesFilter(kind) {
    if (activeFilter === "all") return true;
    if (activeFilter === "none") return kind === "none" || kind === "debunked";
    return kind === activeFilter;
  }

  function matchesSearch(d) {
    if (!searchQuery) return true;
    return d.name.toLowerCase().indexOf(searchQuery.toLowerCase()) > -1;
  }

  function renderBoard() {
    if (!boardRows) return;

    var rows = districts
      .filter(function (d) { return matchesFilter(kindOf(d)) && matchesSearch(d); })
      .sort(function (a, b) {
        /* The reader's own district first — that is the question they came with. */
        var p = (b.name === pinned) - (a.name === pinned);
        if (p) return p;
        var r = ORDER[kindOf(a)] - ORDER[kindOf(b)];
        return r || a.name.localeCompare(b.name);
      });

    boardRows.innerHTML = rows.length
      ? rows.map(rowHtml).join("")
      : '<p class="board-empty">No matching districts found.</p>';
  }

  /* ── The pinned answer, above the board: one district, answered outright. ── */
  function renderPinned() {
    var el = $("pinnedAnswer");
    if (!el) return;

    if (!pinned) {
      el.innerHTML = '<p class="pin-hint">Pin your district below and it will be answered here first.</p>';
      return;
    }

    var d = null;
    for (var i = 0; i < districts.length; i++) {
      if (districts[i].name === pinned) { d = districts[i]; break; }
    }
    if (!d) { el.innerHTML = ""; return; }

    var kind = kindOf(d);
    var line;
    if (kind === "declared") line = d.appliesTo || d.scope || "All educational institutions";
    else if (kind === "partial") line = d.appliesTo || d.scope || "A subset of institutions only";
    else if (kind === "unconfirmed") line = d.scope || "Reported, but no Collector's order confirmed.";
    else if (kind === "debunked") line = d.reason || "Circulating claim, checked and found false.";
    else line = "No closure order reported for this district.";

    var ev = latestEvent(d.name);
    var when = ev && agoText(ev.at);

    el.innerHTML =
      '<p class="pin-label">Your district</p>' +
      '<p class="pin-name">' + esc(d.name) +
        '<span class="pin-verdict v-' + kind + '">' + ICON[kind] + VERDICT_LABEL[kind] + "</span>" +
      "</p>" +
      '<p class="pin-line">' + esc(line) + "</p>" +
      (when ? '<p class="pin-when">Changed ' + esc(when) + "</p>" : "");
  }

  function renderFilters() {
    if (!filtersEl) return;

    var buttons = [{ key: "all", label: "All", n: total }];
    [["declared", "Holiday"], ["partial", "Partial"], ["unconfirmed", "Unconfirmed"]]
      .forEach(function (pair) {
        var n = count(pair[0]);
        if (n > 0) buttons.push({ key: pair[0], label: pair[1], n: n });
      });
    buttons.push({ key: "none", label: "No declaration", n: nNone });

    filtersEl.innerHTML = buttons.map(function (b) {
      return '<button type="button" data-filter="' + b.key + '"' +
        ' aria-pressed="' + (activeFilter === b.key) + '">' +
        esc(b.label) + ' <span class="fc">' + b.n + "</span></button>";
    }).join("");
  }

  if (filtersEl) {
    filtersEl.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-filter]");
      if (!btn) return;
      activeFilter = btn.dataset.filter;
      renderFilters();
      renderBoard();
      /* Keep focus on the tab the reader pressed, not on the container. */
      var next = filtersEl.querySelector('[data-filter="' + activeFilter + '"]');
      if (next) next.focus();
    });
  }

  var searchInput = $("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", function (e) {
      searchQuery = e.target.value;
      renderBoard();
    });
  }

  /* ── Toast. The only transient notice on the page. ── */
  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  /* ── Row actions: pin ── */

  if (boardRows) {
    boardRows.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;
      var row = btn.closest("article.row");
      if (!row) return;
      var name = row.dataset.name;
      var d = null;
      for (var i = 0; i < districts.length; i++) {
        if (districts[i].name === name) { d = districts[i]; break; }
      }
      if (!d) return;

      pinned = pinned === name ? null : name;
      writeStore("krhw-pin", pinned);
      renderPinned();
      renderBoard();
      toast(pinned ? name + " pinned. It will lead the board." : name + " unpinned.");
      /* The row was replaced by the re-render, so focus has to be re-found. */
      var again = boardRows.querySelector('article.row[data-name="' + name + '"] .act-pin');
      if (again) again.focus();
    });
  }

  /* ── What changed since this reader last looked ── */
  (function () {
    var el = $("changes");
    if (!el) return;

    var SEEN = "krhw-seen";
    var raw = readStore(SEEN);
    var snapshot = { forDate: data.forDate, checkedAt: data.checkedAt, districts: {} };
    districts.forEach(function (d) { snapshot.districts[d.name] = kindOf(d); });

    function persist() { writeStore(SEEN, JSON.stringify(snapshot)); }

    var prev = null;
    try { prev = raw ? JSON.parse(raw) : null; } catch (e) { /* corrupt */ }

    /* A snapshot from a different night describes a different question. */
    if (!prev || prev.forDate !== data.forDate || !prev.districts) { persist(); return; }
    if (prev.checkedAt === data.checkedAt) { persist(); return; }

    var moves = [];
    districts.forEach(function (d) {
      var before = prev.districts[d.name];
      var now = kindOf(d);
      if (before && before !== now) moves.push({ name: d.name, from: before, to: now });
    });

    if (!moves.length) { persist(); return; }

    el.innerHTML =
      '<p class="chg-label">Since you last looked</p>' +
      '<ul class="chg-list">' + moves.map(function (m) {
        return '<li class="chg-item c-' + m.to + '">' +
          '<span class="chg-name">' + esc(m.name) + "</span>" +
          '<span class="chg-move">' + esc(VERDICT_LABEL[m.from]) +
            ' <span class="chg-arrow" aria-hidden="true">→</span>' +
            '<span class="sr-only"> changed to </span> ' +
            '<b>' + esc(VERDICT_LABEL[m.to]) + "</b></span>" +
        "</li>";
      }).join("") + "</ul>";
    el.hidden = false;
    persist();
  })();

  renderPinned();
  renderFilters();
  renderBoard();

  var boardFoot = $("boardFoot");
  if (boardFoot) {
    boardFoot.textContent =
      "Verdicts follow the Collector's order as reported. Where a district shows a partial " +
      "closure, the scope line is the operative part — a taluk list or a relief-camp clause " +
      "means most schools are open.";
  }

  /* ── Context ── */
  (function () {
    var el = $("advisories");
    if (!el) return;
    var items = data.advisories || [];
    if (!items.length) {
      el.innerHTML = '<p class="ctx-empty">No advisories accompany tonight’s declarations.</p>';
      return;
    }
    el.innerHTML = items.map(function (a) {
      var level = a.level === "error" ? "error" : a.level === "warn" ? "warn" : "info";
      var tag = level === "error" ? "Correction" : level === "warn" ? "Still developing" : "Also announced";
      return '<div class="adv adv-' + level + '">' +
        '<p class="adv-tag">' + tag + "</p>" +
        '<p class="adv-title">' + esc(a.title) + "</p>" +
        (a.body ? '<p class="adv-body">' + esc(a.body) + "</p>" : "") +
      "</div>";
    }).join("");
  })();

  (function () {
    var el = $("weather");
    if (!el) return;
    var w = data.weather;
    if (!w || (!w.summary && !w.outlook && !w.impact)) {
      el.innerHTML = '<p class="ctx-empty">No weather summary was recorded for this check.</p>';
      return;
    }
    var html = "";
    if (w.summary) html += "<p>" + esc(w.summary) + "</p>";
    if (w.outlook) html += "<p>" + esc(w.outlook) + "</p>";
    if (w.impact) html += "<p><strong>" + esc(w.impact) + "</strong></p>";
    var href = w.source && safeUrl(w.source.url);
    if (href) {
      html += '<p class="ctx-src">Source: <a href="' + esc(href) +
        '" target="_blank" rel="noopener noreferrer">' + esc(w.source.name || href) +
        '<span class="sr-only"> — opens in a new tab</span></a></p>';
    }
    el.innerHTML = html;
  })();

  (function () {
    var wrap = $("debunkedWrap");
    var el = $("debunked");
    if (!wrap || !el) return;
    var items = data.debunked || [];
    if (!items.length) { wrap.hidden = true; return; }
    el.innerHTML = items.map(function (item) {
      var href = safeUrl(item.url);
      return '<div class="dbk">' +
        '<p class="dbk-claim">' + esc(item.claim) + "</p>" +
        '<p class="dbk-verdict">' + esc(item.verdict) + "</p>" +
        (href ? '<p class="dbk-link"><a href="' + esc(href) +
          '" target="_blank" rel="noopener noreferrer">Read the check' +
          '<span class="sr-only"> — opens in a new tab</span></a></p>' : "") +
      "</div>";
    }).join("");
    wrap.hidden = false;
  })();

  (function () {
    var el = $("limits");
    if (!el) return;
    var lims = data.limitations || [];
    if (!lims.length) { el.hidden = true; return; }
    el.innerHTML = "<strong>What this page cannot tell you</strong>" +
      lims.map(esc).join(" ");
  })();

  (function () {
    var el = $("footRule");
    if (!el) return;
    el.textContent = "© " + new Date().getFullYear() +
      " Kerala Rain Holiday Watch · " + total + " districts tracked";
  })();

  /* ── Theme toggle ── */
  (function () {
    var btn = $("themeToggle");
    var label = $("themeLabel");
    var icon = $("themeIcon");
    if (!btn) return;

    var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
    var MOON = '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>';

    function paint() {
      var isDay = document.documentElement.getAttribute("data-theme") === "day";
      btn.setAttribute("aria-pressed", String(isDay));
      /* The control names what pressing it does. */
      label.textContent = isDay ? "Night" : "Day";
      icon.innerHTML = isDay ? MOON : SUN;
      btn.title = isDay ? "Switch to the night board" : "Switch to the day board";
    }

    paint();

    btn.addEventListener("click", function () {
      var isDay = document.documentElement.getAttribute("data-theme") === "day";
      if (isDay) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", "day");
      try { localStorage.setItem("krhw-theme", isDay ? "night" : "day"); } catch (e) { /* private mode */ }
      paint();
    });
  })();

  /* ── Re-check. Only meaningful when served by the companion server. ── */
  (function () {
    var btn = $("refreshBtn");
    if (!btn) return;

    if (location.protocol === "file:") {
      btn.hidden = true;
      return;
    }

    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("is-spinning");

      var done = function () { location.reload(); };
      var fail = function () {
        btn.disabled = false;
        btn.classList.remove("is-spinning");
        var stale = $("staleGuard");
        if (stale) {
          stale.textContent = "Could not re-check just now. The board below is still the last verified result.";
          stale.hidden = false;
        }
      };

      fetch("/api/scrape", { cache: "no-store" })
        .then(function (r) { return r.ok ? done() : fail(); })
        .catch(fail);
    });
  })();

})();
