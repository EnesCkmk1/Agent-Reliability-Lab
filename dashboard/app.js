'use strict';

var COMMAND = 'arl run --dataset datasets/baseline.json --agent scripted';
var DEFAULT_DATASET = 'datasets/baseline.json';

var renderToken = 0;
var activeController = null;

function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatCount(value) {
  var n = finiteOrNull(value);
  return n == null ? 'n/a' : String(n);
}

function formatPercent(rate) {
  var n = finiteOrNull(rate);
  if (n == null) return 'n/a';
  var points = Math.round(n * 1000) / 10;
  return points.toFixed(1) + '%';
}

function formatPercentWithN(rate, sampleSize) {
  var r = finiteOrNull(rate);
  if (r == null) return 'n/a';
  var pct = formatPercent(r);
  var n = finiteOrNull(sampleSize);
  if (n == null) return pct;
  return pct + ' (n=' + n + ')';
}

function formatMs(value) {
  var n = finiteOrNull(value);
  if (n == null) return 'n/a';
  if (Number.isInteger(n)) return n + ' ms';
  return (Math.round(n * 10) / 10).toFixed(1) + ' ms';
}

function formatUsd(value) {
  var sign = value < 0 ? '-' : '';
  var abs = Math.abs(value);
  if (abs === 0) return '$0.00';
  if (abs < 1e-8) return sign + '$' + abs.toExponential(2);
  var digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  var text = abs.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  var dot = text.indexOf('.');
  if (dot === -1) text += '.00';
  else if (text.length - dot - 1 < 2) text += '00'.slice(0, 2 - (text.length - dot - 1));
  return sign + '$' + text;
}

function formatCost(value) {
  if (value == null || value === '') return 'Unavailable';
  var n = finiteOrNull(value);
  if (n == null) return 'Unavailable';
  return formatUsd(n);
}

function formatMaybe(value, decimals) {
  var n = finiteOrNull(value);
  if (n == null) return 'n/a';
  if (Number.isInteger(n)) return String(n);
  var factor = Math.pow(10, decimals);
  return String(Math.round(n * factor) / factor);
}

function formatSignedMs(delta) {
  var n = finiteOrNull(delta);
  if (n == null) return 'n/a';
  if (n === 0) return formatMs(0);
  return (n > 0 ? '+' : '-') + formatMs(Math.abs(n));
}

function formatSignedCost(delta) {
  var n = finiteOrNull(delta);
  if (n == null) return 'n/a';
  if (n === 0) return formatUsd(0);
  return (n > 0 ? '+' : '-') + formatUsd(Math.abs(n));
}

function formatSignedRate(delta) {
  var n = finiteOrNull(delta);
  if (n == null) return 'n/a';
  var points = Math.round(n * 1000) / 10;
  if (points === 0) return '0.0%';
  return (points > 0 ? '+' : '-') + Math.abs(points).toFixed(1) + '%';
}

function formatBool(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value == null) return 'n/a';
  return String(value);
}

function textOrNa(value) {
  if (value == null || value === '') return 'n/a';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function readRate(value) {
  if (typeof value === 'number' || typeof value === 'string') {
    return { rate: finiteOrNull(value), numerator: null, denominator: null };
  }
  if (value && typeof value === 'object') {
    return {
      rate: finiteOrNull(value.rate),
      numerator: finiteOrNull(value.numerator),
      denominator: finiteOrNull(value.denominator)
    };
  }
  return { rate: null, numerator: null, denominator: null };
}

function formatRatePercent(value) {
  return formatPercent(readRate(value).rate);
}

function ratioText(part, whole) {
  var a = finiteOrNull(part);
  var b = finiteOrNull(whole);
  if (a == null || b == null) return 'n/a';
  return a + '/' + b;
}

function isAbort(err) {
  return !!(err && err.name === 'AbortError');
}

function isCurrent(token) {
  return token === renderToken;
}

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value == null || value === false) return;
      if (key === 'class') node.className = String(value);
      else if (key === 'hidden') node.hidden = true;
      else node.setAttribute(key, value === true ? '' : String(value));
    });
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children == null) return;
  var list = Array.isArray(children) ? children : [children];
  list.forEach(function (child) {
    if (child == null || child === false) return;
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  });
}

function paragraph(text) {
  var p = el('p');
  p.textContent = text == null ? '' : String(text);
  return p;
}

function button(label, className, onClick) {
  var node = el('button', { type: 'button', class: className || 'btn' }, label);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function mono(value, extra) {
  var span = el('span', { class: extra ? 'mono ' + extra : 'mono' });
  span.textContent = value == null || value === '' ? 'n/a' : String(value);
  return span;
}

function breakableId(value) {
  var span = el('span', { class: 'mono' });
  if (value == null || value === '') {
    span.textContent = 'n/a';
    return span;
  }
  var text = String(value);
  span.title = text;
  var parts = text.split('_');
  parts.forEach(function (part, index) {
    if (index) span.appendChild(document.createTextNode('_'));
    var stamp = part.match(/^(\d{8})(T.+)$/);
    if (stamp) {
      span.appendChild(document.createTextNode(stamp[1]));
      span.appendChild(document.createElement('wbr'));
      span.appendChild(document.createTextNode(stamp[2]));
    } else {
      span.appendChild(document.createTextNode(part));
    }
    if (index < parts.length - 1) span.appendChild(document.createElement('wbr'));
  });
  return span;
}

function badge(text, kind) {
  return el('span', { class: 'badge ' + kind }, text);
}

function jsonPre(value) {
  var pre = el('pre', { class: 'json' });
  if (value === undefined) {
    pre.textContent = 'n/a';
    return pre;
  }
  try {
    var text = JSON.stringify(value, null, 2);
    pre.textContent = text == null ? 'n/a' : text;
  } catch (err) {
    pre.textContent = String(value);
  }
  return pre;
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    var text = JSON.stringify(value);
    return text == null ? String(value) : text;
  } catch (err) {
    return String(value);
  }
}

function richValue(value) {
  if (value == null) return paragraph('n/a');
  if (typeof value === 'string') {
    var pre = el('pre', { class: 'text' });
    pre.textContent = value;
    return pre;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return paragraph(String(value));
  return jsonPre(value);
}

function looseText(value) {
  if (value == null || value === '') return 'n/a';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return jsonPre(value);
}

function stringList(items) {
  var ul = el('ul', { class: 'compact' });
  items.forEach(function (item) {
    var li = el('li');
    if (typeof item === 'string') li.textContent = item;
    else if (item == null) li.textContent = 'n/a';
    else if (typeof item === 'number' || typeof item === 'boolean') li.textContent = String(item);
    else li.appendChild(jsonPre(item));
    ul.appendChild(li);
  });
  return ul;
}

function notesNode(notes) {
  if (notes == null || notes === '') return paragraph('n/a');
  if (Array.isArray(notes)) {
    if (!notes.length) return paragraph('None');
    return stringList(notes);
  }
  if (typeof notes === 'string') return richValue(notes);
  return jsonPre(notes);
}

function faultsNode(faults) {
  if (faults == null) return paragraph('n/a');
  if (typeof faults === 'string') return paragraph(faults);
  if (Array.isArray(faults)) {
    if (!faults.length) return paragraph('None');
    if (faults.every(function (item) { return typeof item === 'string'; })) return stringList(faults);
    if (faults.every(function (item) { return item && typeof item === 'object' && !Array.isArray(item); })) {
      return stringList(faults.map(function (item) {
        var bits = [];
        if (item.id != null) bits.push(String(item.id));
        if (item.kind != null) bits.push(String(item.kind));
        if (item.target != null) bits.push(String(item.target));
        var line = bits.join(' · ');
        if (item.params != null) line += (line ? ' · ' : '') + stringify(item.params);
        return line || stringify(item);
      }));
    }
    return jsonPre(faults);
  }
  return jsonPre(faults);
}

function formatGenerator(value) {
  if (value == null || value === '') return 'n/a';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.generator === 'string') {
      return value.version == null || value.version === '' ? value.generator : value.generator + ' ' + value.version;
    }
    if (value.name != null || value.version != null) {
      var name = value.name == null ? '' : String(value.name);
      var version = value.version == null || value.version === '' ? '' : String(value.version);
      var text = (name + (version ? ' ' + version : '')).trim();
      if (text) return text;
    }
  }
  return looseText(value);
}

function pageHeader(title, lede) {
  var header = el('header', { class: 'page-header' });
  header.appendChild(el('h1', null, title));
  if (lede) header.appendChild(el('p', { class: 'lede' }, lede));
  return header;
}

function panelBlock(title, node) {
  var wrap = el('div', { class: 'stack tight' });
  wrap.appendChild(el('h3', null, title));
  wrap.appendChild(node);
  return wrap;
}

function kv(pairs) {
  var dl = el('dl', { class: 'kv' });
  pairs.forEach(function (pair) {
    var dt = el('dt');
    dt.textContent = pair[0];
    var dd = el('dd');
    var value = pair[1];
    if (value instanceof Node) dd.appendChild(value);
    else if (value == null || value === '') dd.textContent = 'n/a';
    else dd.textContent = String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  });
  return dl;
}

function td(content, className) {
  var cell = el('td', className ? { class: className } : null);
  if (content instanceof Node) cell.appendChild(content);
  else if (content != null && content !== false) cell.textContent = String(content);
  return cell;
}

function tdNum(content) {
  return td(content, 'num');
}

function makeTable(caption, columns) {
  var wrap = el('div', { class: 'table-wrap' });
  var table = el('table');
  var thead = el('thead');
  var headRow = el('tr');
  columns.forEach(function (column) {
    headRow.appendChild(el('th', { scope: 'col', class: column.num ? 'num' : null }, column.label));
  });
  thead.appendChild(headRow);
  var tbody = el('tbody');
  table.appendChild(el('caption', { class: 'sr-only' }, caption));
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return { wrap: wrap, tbody: tbody };
}

function emptyRow(colspan, message) {
  var tr = el('tr', { class: 'empty-row' });
  var cell = el('td', { colspan: String(colspan) });
  cell.textContent = message;
  tr.appendChild(cell);
  return tr;
}

function timeText(iso) {
  if (iso == null || iso === '') return el('span', { class: 'muted' }, 'n/a');
  var span = el('time', { class: 'mono' });
  span.textContent = String(iso);
  var parsed = Date.parse(iso);
  if (!Number.isNaN(parsed)) {
    span.setAttribute('datetime', String(iso));
    span.title = new Date(parsed).toLocaleString();
  }
  return span;
}

function warningCallout(message, reasons) {
  var box = el('div', { class: 'callout warn' });
  var p = el('p');
  p.textContent = message;
  box.appendChild(p);
  if (Array.isArray(reasons) && reasons.length) {
    box.appendChild(el('h3', null, 'Suppressed reasons'));
    box.appendChild(stringList(reasons));
  }
  return box;
}

function warningsBlock(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return null;
  var box = el('div', { class: 'callout warn' });
  box.appendChild(el('div', { class: 'kicker' }, 'Warnings'));
  box.appendChild(stringList(warnings));
  return box;
}

function errorBlock(err) {
  var box = el('div', { class: 'callout danger', role: 'alert' });
  box.appendChild(el('div', { class: 'kicker' }, 'Request failed'));
  var p = el('p');
  p.textContent = err && err.message ? err.message : 'Unknown error';
  box.appendChild(p);
  return box;
}

function emptyRuns() {
  var box = el('div', { class: 'empty' });
  var p = el('p');
  p.textContent = 'No runs yet. Run this command to record one:';
  var pre = el('pre', { class: 'command' });
  pre.textContent = COMMAND;
  box.appendChild(p);
  box.appendChild(pre);
  return box;
}

function syntheticBanner(label) {
  var box = el('div', { class: 'callout violet' });
  box.appendChild(el('div', { class: 'kicker' }, 'Synthetic'));
  var p = el('p');
  p.textContent = label == null || label === '' ? 'Synthetic' : String(label);
  box.appendChild(p);
  return box;
}

function externalBadge() {
  return badge('External data', 'external');
}

function statCard(label, value, hint, warn) {
  var card = el('article', { class: warn ? 'stat warn' : 'stat' });
  card.appendChild(el('div', { class: 'label' }, label));
  var valueNode = el('div', { class: 'value' });
  if (value instanceof Node) valueNode.appendChild(value);
  else valueNode.textContent = value == null ? 'n/a' : String(value);
  card.appendChild(valueNode);
  if (hint) {
    var hintNode = el('div', { class: 'hint' });
    hintNode.textContent = hint;
    card.appendChild(hintNode);
  }
  return card;
}

function sampleHint(n) {
  var value = finiteOrNull(n);
  if (value == null) return null;
  return 'n=' + value;
}

function rateNode(value) {
  var parsed = readRate(value);
  var span = el('span', { class: 'metric' });
  span.textContent = formatPercentWithN(parsed.rate, parsed.denominator);
  if (parsed.numerator != null && parsed.denominator != null) {
    span.title = parsed.numerator + '/' + parsed.denominator;
  }
  return span;
}

function bar(rate, tone) {
  var n = finiteOrNull(rate);
  if (n == null) return null;
  var width = Math.max(0, Math.min(1, n)) * 100;
  var track = el('div', { class: 'bar-track' });
  var fill = el('div', { class: tone ? 'bar-fill ' + tone : 'bar-fill' });
  fill.style.width = width + '%';
  track.appendChild(fill);
  track.setAttribute('aria-hidden', 'true');
  return track;
}

function barRow(label, rateValue, tone) {
  var parsed = readRate(rateValue);
  var row = el('div', { class: 'bar-row' });
  row.appendChild(el('span', { class: 'bar-label' }, label));
  var graphic = el('div', { class: 'bar-graphic' });
  var drawn = bar(parsed.rate, tone);
  if (drawn) graphic.appendChild(drawn);
  row.appendChild(graphic);
  var value = rateNode(rateValue);
  value.classList.add('bar-value');
  row.appendChild(value);
  return row;
}

function failureBars(map, tone) {
  if (map == null) return paragraph('n/a');
  if (typeof map !== 'object' || Array.isArray(map)) return jsonPre(map);
  var keys = Object.keys(map);
  if (!keys.length) return paragraph('No category rates were returned.');
  var wrap = el('div', { class: 'bars' });
  keys.forEach(function (key) {
    wrap.appendChild(barRow(key, map[key], tone));
  });
  return wrap;
}

function deltaNode(delta, text, higherIsBetter) {
  var n = finiteOrNull(delta);
  var tone = '';
  if (n != null && n !== 0) {
    var positive = n > 0;
    var good = higherIsBetter ? positive : !positive;
    tone = good ? ' good' : ' bad';
  }
  return el('span', { class: 'delta' + tone }, text);
}

function outcomeClass(outcome) {
  if (outcome === 'succeeded') return 'outcome ok';
  if (outcome === 'failed' || outcome === 'invalid_output' || outcome === 'timeout' || outcome === 'retry_exhausted') return 'outcome bad';
  if (outcome === 'cancelled' || outcome === 'infrastructure_error' || outcome === 'incomplete') return 'outcome muted';
  return 'outcome';
}

function outcomeNode(outcome) {
  var span = el('span', { class: outcomeClass(outcome) });
  span.textContent = outcome == null || outcome === '' ? 'n/a' : String(outcome);
  return span;
}

function runLink(id) {
  var anchor = el('a', { class: 'mono', href: '#/runs/' + encodeURIComponent(String(id)) });
  anchor.textContent = String(id);
  return anchor;
}

function taskRunLink(taskId, runId) {
  var anchor = el('a', { class: 'mono', href: '#/runs/' + encodeURIComponent(String(runId)) });
  anchor.textContent = String(taskId);
  anchor.title = 'Open run ' + String(runId);
  return anchor;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function buildHash(path, query) {
  var parts = [];
  if (query) {
    Object.keys(query).forEach(function (key) {
      var value = query[key];
      if (value == null || value === '') return;
      if (key === 'runs') {
        parts.push('runs=' + String(value).split(',').map(encodeURIComponent).join(','));
        return;
      }
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
  }
  return '#' + path + (parts.length ? '?' + parts.join('&') : '');
}

function withQuery(path, pairs) {
  var parts = [];
  pairs.forEach(function (pair) {
    if (pair[1] == null || pair[1] === '') return;
    parts.push(encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]));
  });
  if (!parts.length) return path;
  return path + '?' + parts.join('&');
}

function variationPath(ids) {
  return '/api/variation?runs=' + ids.map(function (id) { return encodeURIComponent(id); }).join(',');
}

function storageGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch (err) {
    return null;
  }
  return value;
}

async function fetchJson(url, signal) {
  if (typeof url !== 'string' || url.indexOf('/api/') !== 0) {
    throw new Error('Refusing a non-API request.');
  }
  var response = await fetch(url, {
    method: 'GET',
    signal: signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  });
  var text = await response.text();
  var body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = null;
    }
  }
  if (!response.ok) {
    var message = body && typeof body.error === 'string' && body.error.trim()
      ? body.error
      : 'HTTP ' + response.status;
    var error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (body == null) throw new Error('HTTP ' + response.status + ' returned an empty body.');
  return body;
}

async function settle(promise) {
  try {
    return { ok: true, data: await promise };
  } catch (err) {
    return { ok: false, err: err };
  }
}

function requireRuns(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.runs)) {
    throw new Error('The runs response did not include a runs array.');
  }
  return payload.runs;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

function parseRoute() {
  var raw = location.hash || '#/';
  if (raw === '#') raw = '#/';
  var queryIndex = raw.indexOf('?');
  var pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  var query = queryIndex === -1 ? '' : raw.slice(queryIndex + 1);
  var params = new URLSearchParams(query);
  var path = pathPart.replace(/^#/, '');
  if (path.charAt(0) !== '/') path = '/' + path;
  if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
  if (path === '/' || path === '') return { view: 'overview', params: params, path: path };
  if (path === '/runs') return { view: 'runs', params: params, path: path };
  if (path.indexOf('/runs/') === 0) {
    var id = safeDecode(path.slice('/runs/'.length));
    if (!id) return { view: 'runs', params: params, path: path };
    return { view: 'run', id: id, params: params, path: path };
  }
  if (path === '/compare') return { view: 'compare', params: params, path: path };
  if (path === '/datasets') return { view: 'datasets', params: params, path: path };
  if (path === '/reliability') return { view: 'reliability', params: params, path: path };
  return { view: 'unknown', params: params, path: path };
}

function updateNav(route) {
  var key = route.view === 'run' ? 'runs' : route.view;
  document.querySelectorAll('[data-nav]').forEach(function (buttonNode) {
    if (buttonNode.getAttribute('data-nav') === key) buttonNode.setAttribute('aria-current', 'page');
    else buttonNode.removeAttribute('aria-current');
  });
}

function titleFor(route) {
  if (route.view === 'run' && route.id) return 'Run ' + route.id + ' · Agent Reliability Lab';
  var names = {
    overview: 'Overview',
    runs: 'Runs',
    compare: 'Compare',
    datasets: 'Datasets',
    reliability: 'Reliability'
  };
  return (names[route.view] || 'Agent Reliability Lab') + ' · Agent Reliability Lab';
}

function linkRow(tr, hash) {
  tr.classList.add('clickable');
  tr.tabIndex = 0;
  var activate = function () { go(hash); };
  tr.addEventListener('click', activate);
  tr.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
}

function runOptionLabel(run) {
  var when = run.startedAt ? String(run.startedAt) : 'time n/a';
  var agent = run.agentName ? String(run.agentName) : 'agent n/a';
  var model = run.model ? ' / ' + String(run.model) : '';
  var version = run.datasetVersion ? String(run.datasetVersion) : 'dataset n/a';
  var label = when + ' · ' + String(run.id) + ' · ' + agent + model + ' · ' + version;
  if (run.status && run.status !== 'completed') label += ' · ' + String(run.status);
  return label;
}

function runSelect(runs, selected) {
  var select = el('select', { class: 'select-wide' });
  select.appendChild(el('option', { value: '' }, 'Select a run'));
  var selectedText = selected == null ? '' : String(selected);
  var found = selectedText === '';
  runs.forEach(function (run) {
    if (!run || run.id == null || run.id === '') return;
    var id = String(run.id);
    var option = el('option', { value: id });
    option.textContent = runOptionLabel(run);
    if (id === selectedText) found = true;
    select.appendChild(option);
  });
  if (selectedText && !found) {
    var extra = el('option', { value: selectedText });
    extra.textContent = selectedText + ' (not in the current list)';
    select.appendChild(extra);
  }
  select.value = selectedText;
  return select;
}

function flagsFor(run) {
  var wrap = el('div', { class: 'flags' });
  if (run.status && run.status !== 'completed') wrap.appendChild(badge(String(run.status), 'status'));
  if (run.datasetSynthetic) {
    var synthetic = badge('Synthetic', 'synthetic');
    if (run.datasetLabel) synthetic.title = String(run.datasetLabel);
    wrap.appendChild(synthetic);
  }
  if (run.usesAnswerKey) wrap.appendChild(badge('Answer key', 'answer'));
  if (run.evaluationClass === 'seeded_stress') wrap.appendChild(badge('Stress', 'stress'));
  if (!wrap.childNodes.length) {
    var none = el('span', { class: 'muted' });
    none.textContent = 'None';
    wrap.appendChild(none);
  }
  return wrap;
}

function agentCell(run) {
  var wrap = el('div');
  var name = el('div');
  name.textContent = run.agentName ? String(run.agentName) : 'n/a';
  wrap.appendChild(name);
  if (run.model) {
    var model = el('div', { class: 'hint mono' });
    model.textContent = String(run.model);
    wrap.appendChild(model);
  }
  return wrap;
}

function successCell(run) {
  var wrap = el('div');
  var line = el('div');
  line.textContent = formatPercentWithN(run.successRate, run.evaluated);
  if (finiteOrNull(run.successes) != null && finiteOrNull(run.evaluated) != null) {
    line.title = run.successes + '/' + run.evaluated;
  }
  wrap.appendChild(line);
  if (run.smallSample) wrap.appendChild(el('div', { class: 'hint' }, 'Small sample'));
  return wrap;
}

function datasetVersionCell(run) {
  var span = mono(run.datasetVersion);
  if (run.datasetLabel) span.title = String(run.datasetLabel);
  return td(span);
}

function regressionsSection(items) {
  var section = el('section', { class: 'stack' });
  section.appendChild(el('h2', null, 'Recent regressions'));
  if (!Array.isArray(items) || !items.length) {
    section.appendChild(paragraph('No recent regressions.'));
    return section;
  }
  var table = makeTable('Recent regressions', [
    { label: 'Started' },
    { label: 'Baseline' },
    { label: 'Candidate' },
    { label: 'Reasons' },
    { label: 'Action' }
  ]);
  items.forEach(function (item) {
    var row = item || {};
    var tr = el('tr');
    var baseline = row.baselineRunId;
    var candidate = row.candidateRunId;
    var href = baseline && candidate
      ? buildHash('/compare', { baseline: String(baseline), candidate: String(candidate) })
      : '';
    if (href) linkRow(tr, href);
    var baselineCell = el('td');
    var candidateCell = el('td');
    if (baseline) {
      var baselineLink = runLink(baseline);
      baselineLink.addEventListener('click', function (event) { event.stopPropagation(); });
      baselineCell.appendChild(baselineLink);
    } else baselineCell.textContent = 'n/a';
    if (candidate) {
      var candidateLink = runLink(candidate);
      candidateLink.addEventListener('click', function (event) { event.stopPropagation(); });
      candidateCell.appendChild(candidateLink);
    } else candidateCell.textContent = 'n/a';
    var action = el('td');
    if (href) {
      var compareLink = el('a', { href: href }, 'Compare');
      compareLink.addEventListener('click', function (event) { event.stopPropagation(); });
      action.appendChild(compareLink);
    } else action.textContent = 'n/a';
    var reasons = Array.isArray(row.reasons) && row.reasons.length ? stringList(row.reasons) : 'None';
    tr.appendChild(td(timeText(row.candidateStartedAt), 'nowrap'));
    tr.appendChild(baselineCell);
    tr.appendChild(candidateCell);
    tr.appendChild(td(reasons, 'wrap'));
    tr.appendChild(action);
    table.tbody.appendChild(tr);
  });
  section.appendChild(table.wrap);
  return section;
}

function definitionsTable(definitions) {
  var table = makeTable('Metric definitions', [
    { label: 'Name' },
    { label: 'Id' },
    { label: 'Numerator' },
    { label: 'Denominator' },
    { label: 'Exclusions' },
    { label: 'Aggregation' }
  ]);
  definitions.forEach(function (definition) {
    var item = definition || {};
    var exclusions;
    if (item.exclusions == null || item.exclusions === '') exclusions = 'n/a';
    else if (Array.isArray(item.exclusions)) exclusions = item.exclusions.length ? stringList(item.exclusions) : 'None';
    else exclusions = looseText(item.exclusions);
    var tr = el('tr');
    tr.appendChild(td(textOrNa(item.name), 'wrap'));
    tr.appendChild(td(mono(item.id)));
    tr.appendChild(td(looseText(item.numerator), 'wrap'));
    tr.appendChild(td(looseText(item.denominator), 'wrap'));
    tr.appendChild(td(exclusions, 'wrap'));
    tr.appendChild(td(looseText(item.aggregation), 'wrap'));
    table.tbody.appendChild(tr);
  });
  return table.wrap;
}

function definitionsBlock(definitions, error) {
  var details = el('details');
  if (error) details.open = true;
  details.appendChild(el('summary', null, 'Metric definitions'));
  var body = el('div', { class: 'detail-gap' });
  if (error) {
    var message = el('p', { class: 'fail' });
    message.textContent = error;
    body.appendChild(message);
  }
  if (Array.isArray(definitions)) {
    body.appendChild(definitions.length ? definitionsTable(definitions) : paragraph('No definitions were returned.'));
  } else if (!error) {
    var invalid = el('p', { class: 'fail' });
    invalid.textContent = 'The definitions response was not a list.';
    body.appendChild(invalid);
  }
  details.appendChild(body);
  return details;
}

function overviewStats(overview) {
  var grid = el('div', { class: 'stats' });
  var successHint = null;
  if (finiteOrNull(overview.successRate) == null && finiteOrNull(overview.successSampleSize) != null) {
    successHint = 'n=' + finiteOrNull(overview.successSampleSize);
  }
  var coverage = overview.costCoverage;
  var coverageValue = 'n/a';
  if (coverage) {
    var ratio = ratioText(coverage.runsWithCost, coverage.runs);
    coverageValue = ratio === 'n/a' ? ratio : ratio + ' runs';
  }
  [
    statCard('Runs', formatCount(overview.totalRuns)),
    statCard('Tasks evaluated', formatCount(overview.tasksEvaluated)),
    statCard('Successes', formatCount(overview.successes)),
    statCard('Success rate', formatPercentWithN(overview.successRate, overview.successSampleSize), successHint, !!overview.smallSample),
    statCard('Median latency', formatMs(overview.medianLatencyMs), sampleHint(overview.latencySampleSize)),
    statCard('P95 latency', formatMs(overview.p95LatencyMs), sampleHint(overview.latencySampleSize)),
    statCard('Estimated cost', formatCost(overview.estimatedCostUsd)),
    statCard('Cost coverage', coverageValue),
    statCard('Synthetic runs', formatCount(overview.syntheticRunCount)),
    statCard('External runs', formatCount(overview.externalRunCount))
  ].forEach(function (card) { grid.appendChild(card); });
  return grid;
}

function overviewPage(overview, definitions, definitionsError) {
  var page = el('div', { class: 'page' });
  page.appendChild(pageHeader('Overview', 'Counts and rates from runs recorded on this machine.'));
  if (typeof overview.notice === 'string' && overview.notice.trim()) {
    var note = el('div', { class: 'callout note' });
    var noteText = el('p');
    noteText.textContent = overview.notice;
    note.appendChild(noteText);
    page.appendChild(note);
  }
  if (overview.totalRuns === 0) {
    page.appendChild(emptyRuns());
    if (Array.isArray(overview.recentRegressions) && overview.recentRegressions.length) {
      page.appendChild(regressionsSection(overview.recentRegressions));
    }
  } else {
    page.appendChild(overviewStats(overview));
    if (overview.smallSample) page.appendChild(warningCallout('The sample is too small for a firm conclusion.'));
    page.appendChild(regressionsSection(overview.recentRegressions));
  }
  page.appendChild(definitionsBlock(definitions, definitionsError));
  return page;
}

function runsPage(runs) {
  var page = el('div', { class: 'page' });
  page.appendChild(pageHeader('Runs', 'Each row is one recorded run.'));
  if (!runs.length) {
    page.appendChild(emptyRuns());
    return page;
  }
  var table = makeTable('Runs', [
    { label: 'Started' },
    { label: 'Run id' },
    { label: 'Dataset version' },
    { label: 'Agent' },
    { label: 'Scenario' },
    { label: 'Success', num: true },
    { label: 'Median latency', num: true },
    { label: 'Cost', num: true },
    { label: 'Flags' }
  ]);
  runs.forEach(function (run) {
    if (!run || typeof run !== 'object') return;
    var tr = el('tr');
    if (run.id != null && run.id !== '') linkRow(tr, '#/runs/' + encodeURIComponent(String(run.id)));
    tr.appendChild(td(timeText(run.startedAt), 'nowrap'));
    tr.appendChild(td(breakableId(run.id)));
    tr.appendChild(datasetVersionCell(run));
    tr.appendChild(td(agentCell(run)));
    tr.appendChild(td(textOrNa(run.scenarioMode)));
    tr.appendChild(tdNum(successCell(run)));
    tr.appendChild(tdNum(formatMs(run.medianLatencyMs)));
    tr.appendChild(tdNum(formatCost(run.estimatedCostUsd)));
    tr.appendChild(td(flagsFor(run)));
    table.tbody.appendChild(tr);
  });
  page.appendChild(table.wrap);
  return page;
}

function formatEnv(env) {
  if (!env || typeof env !== 'object') return 'n/a';
  function part(value) { return value == null || value === '' ? 'n/a' : String(value); }
  return 'node ' + part(env.node) + ' · ' + part(env.platform) + ' · ' + part(env.arch);
}

function configDetails(config) {
  var details = el('details');
  details.appendChild(el('summary', null, 'Agent config'));
  var body = el('div', { class: 'detail-gap' });
  body.appendChild(config == null ? paragraph('n/a') : jsonPre(config));
  details.appendChild(body);
  return details;
}

function excludedText(excluded) {
  if (excluded == null || excluded === '') return '';
  if (typeof excluded === 'number' || typeof excluded === 'string') return 'Excluded ' + excluded + '.';
  if (typeof excluded === 'object') {
    return 'Excluded cancelled ' + formatCount(excluded.cancelled)
      + ', infrastructure_error ' + formatCount(excluded.infrastructure_error)
      + ', incomplete ' + formatCount(excluded.incomplete) + '.';
  }
  return '';
}

function sampleSummary(sample) {
  if (!sample || typeof sample !== 'object') return null;
  var bits = [];
  if (sample.evaluated != null && sample.total != null) bits.push('Evaluated ' + sample.evaluated + ' of ' + sample.total + '.');
  else if (sample.evaluated != null) bits.push('Evaluated ' + sample.evaluated + '.');
  var excluded = excludedText(sample.excluded);
  if (excluded) bits.push(excluded);
  if (sample.minSampleSize != null) bits.push('Minimum sample size ' + sample.minSampleSize + '.');
  if (!bits.length) return null;
  var p = el('p', { class: 'sample-line muted' });
  p.textContent = bits.join(' ');
  return p;
}

function latencyCard(latency) {
  var card = el('section', { class: 'card stack' });
  card.appendChild(el('h2', null, 'Latency'));
  if (!latency || typeof latency !== 'object') {
    card.appendChild(paragraph('n/a'));
    return card;
  }
  card.appendChild(kv([
    ['Median', formatMs(latency.median)],
    ['P95', formatMs(latency.p95)],
    ['Sample size', formatCount(latency.sampleSize)],
    ['Excluded missing timestamps', formatCount(latency.excludedMissingTimestamps)]
  ]));
  return card;
}

function tokenCard(tokens) {
  var card = el('section', { class: 'card stack' });
  card.appendChild(el('h2', null, 'Tokens'));
  if (!tokens || typeof tokens !== 'object') {
    card.appendChild(paragraph('n/a'));
    return card;
  }
  card.appendChild(kv([
    ['Recorded input tokens', formatCount(tokens.recordedInputTokens)],
    ['Recorded output tokens', formatCount(tokens.recordedOutputTokens)],
    ['Recorded total tokens', formatCount(tokens.recordedTotalTokens)],
    ['Tasks with usage', formatCount(tokens.tasksWithUsage)],
    ['Tasks missing usage', formatCount(tokens.tasksMissingUsage)]
  ]));
  return card;
}

function costCard(metrics) {
  var card = el('section', { class: 'card stack' });
  card.appendChild(el('h2', null, 'Cost'));
  var cost = metrics.estimatedCostUsd || {};
  var coverage = metrics.costPerSuccessfulTaskCoverage || {};
  card.appendChild(kv([
    ['Recorded total', formatCost(metrics.estimatedCostUsd ? cost.recordedTotalUsd : null)],
    ['Mean per costed task', formatCost(metrics.estimatedCostUsd ? cost.meanPerRunUsd : null)],
    ['Tasks with cost', metrics.estimatedCostUsd ? formatCount(cost.tasksWithCost) : 'n/a'],
    ['Tasks missing cost', metrics.estimatedCostUsd ? formatCount(cost.tasksMissingCost) : 'n/a'],
    ['Cost per successful task', formatCost(metrics.costPerSuccessfulTaskUsd)],
    ['Successes with cost', metrics.costPerSuccessfulTaskCoverage ? ratioText(coverage.successesWithCost, coverage.successes) : 'n/a']
  ]));
  return card;
}

function metricsSection(metrics) {
  var section = el('section', { class: 'stack' });
  section.appendChild(el('h2', null, 'Metrics'));
  if (!metrics || typeof metrics !== 'object') {
    section.appendChild(paragraph('n/a'));
    return section;
  }
  var summary = sampleSummary(metrics.sample);
  if (summary) section.appendChild(summary);
  if (metrics.sample && metrics.sample.smallSample) {
    section.appendChild(warningCallout('The sample is too small for a firm conclusion.'));
  }
  var warnings = warningsBlock(metrics.warnings);
  if (warnings) section.appendChild(warnings);
  var table = makeTable('Metric rates', [
    { label: 'Metric' },
    { label: 'Result', num: true }
  ]);
  [
    ['Task success rate', metrics.taskSuccessRate],
    ['Exact match accuracy', metrics.exactMatchAccuracy],
    ['Schema compliance', metrics.schemaComplianceRate],
    ['Tool-call success', metrics.toolCallSuccessRate],
    ['Recovery success', metrics.recoverySuccessRate],
    ['Timeout rate', metrics.timeoutRate]
  ].forEach(function (row) {
    var tr = el('tr');
    tr.appendChild(td(row[0]));
    tr.appendChild(tdNum(rateNode(row[1])));
    table.tbody.appendChild(tr);
  });
  section.appendChild(table.wrap);
  section.appendChild(el('h3', null, 'Failure rate by category'));
  section.appendChild(failureBars(metrics.failureRateByCategory, 'bad'));
  section.appendChild(latencyCard(metrics.latencyMs));
  section.appendChild(tokenCard(metrics.tokenUsage));
  section.appendChild(costCard(metrics));
  return section;
}

function criteriaTable(items) {
  if (items == null) return paragraph('n/a');
  if (!Array.isArray(items)) return jsonPre(items);
  if (!items.length) return paragraph('None');
  var table = makeTable('Criteria results', [
    { label: 'Type' },
    { label: 'Passed' },
    { label: 'Detail' }
  ]);
  items.forEach(function (item) {
    var row = item || {};
    var passed = row.passed;
    var pass = el('span', { class: passed === true ? 'pass' : passed === false ? 'fail' : 'muted' });
    pass.textContent = passed === true ? 'Passed' : passed === false ? 'Failed' : 'n/a';
    var detail = el('td', { class: 'wrap' });
    if (row.detail == null || row.detail === '') detail.textContent = 'n/a';
    else if (typeof row.detail === 'string') detail.textContent = row.detail;
    else detail.appendChild(jsonPre(row.detail));
    var tr = el('tr');
    var typeCell = el('td');
    typeCell.textContent = row.type == null ? 'n/a' : String(row.type);
    var passCell = el('td');
    passCell.appendChild(pass);
    tr.appendChild(typeCell);
    tr.appendChild(passCell);
    tr.appendChild(detail);
    table.tbody.appendChild(tr);
  });
  return table.wrap;
}

function toolCallItem(call, index) {
  var source = call || {};
  var li = el('li');
  li.appendChild(el('span', { class: 'tl-dot', 'aria-hidden': 'true' }));
  var title = el('div', { class: 'tl-title' });
  title.textContent = (index + 1) + '. ' + textOrNa(source.tool) + ' · ' + textOrNa(source.status) + ' · attempt ' + textOrNa(source.attempt);
  var meta = el('div', { class: 'tl-meta' });
  meta.textContent = 'Duration ' + formatMs(source.durationMs) + ' · Simulated delay ' + formatMs(source.simulatedDelayMs) + ' · Fault ' + textOrNa(source.injectedFaultId);
  li.appendChild(title);
  li.appendChild(meta);
  if (source.arguments != null) {
    li.appendChild(el('div', { class: 'tl-meta' }, 'Arguments'));
    li.appendChild(jsonPre(source.arguments));
  }
  if (source.result != null) {
    li.appendChild(el('div', { class: 'tl-meta' }, 'Result'));
    li.appendChild(jsonPre(source.result));
  }
  if (source.error != null && source.error !== '') {
    var err = el('div', { class: 'fail' });
    err.textContent = typeof source.error === 'string' ? source.error : stringify(source.error);
    li.appendChild(err);
  }
  return li;
}

function toolTimeline(calls) {
  if (calls == null) return paragraph('n/a');
  if (!Array.isArray(calls)) return jsonPre(calls);
  if (!calls.length) return paragraph('None');
  var list = el('ol', { class: 'timeline' });
  calls.forEach(function (call, index) { list.appendChild(toolCallItem(call, index)); });
  return list;
}

function eventsList(events) {
  if (events == null) return paragraph('n/a');
  if (!Array.isArray(events)) return jsonPre(events);
  if (!events.length) return paragraph('None');
  var list = el('ol', { class: 'timeline' });
  events.forEach(function (event, index) {
    var li = el('li');
    li.appendChild(el('span', { class: 'tl-dot', 'aria-hidden': 'true' }));
    li.appendChild(el('div', { class: 'tl-title' }, 'Event ' + (index + 1)));
    li.appendChild(eventBody(event));
    list.appendChild(li);
  });
  return list;
}

function renderTaskPanel(task) {
  var source = task || {};
  var panel = el('div', { class: 'task-panel' });
  panel.appendChild(panelBlock('Failure reason', paragraph(textOrNa(source.failureReason))));
  var split = el('div', { class: 'split' });
  split.appendChild(panelBlock('Expected output', jsonPre(source.expectedOutput)));
  split.appendChild(panelBlock('Actual output', jsonPre(source.actualOutput)));
  panel.appendChild(split);
  if (source.actualOutputText != null && source.actualOutputText !== '') {
    panel.appendChild(panelBlock('Actual output text', richValue(source.actualOutputText)));
  }
  var criteria = source.criteriaResults != null ? source.criteriaResults : source.criteria;
  panel.appendChild(panelBlock('Criteria results', criteriaTable(criteria)));
  panel.appendChild(panelBlock('Tool calls', toolTimeline(source.toolCalls)));
  panel.appendChild(panelBlock('Injected events', eventsList(source.injectedEvents)));
  return panel;
}

function renderTaskTable(tasks) {
  var columns = [
    { label: 'Task' },
    { label: 'Category' },
    { label: 'Difficulty' },
    { label: 'Scenario' },
    { label: 'Outcome' },
    { label: 'Duration', num: true },
    { label: 'Retries', num: true },
    { label: 'Failure reason' }
  ];
  var table = makeTable('Tasks', columns);
  if (!tasks.length) {
    table.tbody.appendChild(emptyRow(columns.length, 'No tasks were returned.'));
    return table.wrap;
  }
  tasks.forEach(function (task) {
    var source = task || {};
    var summary = el('tr', { class: 'clickable' });
    summary.tabIndex = 0;
    summary.setAttribute('aria-expanded', 'false');
    var detail = el('tr', { class: 'detail', hidden: true });
    var panelCell = el('td', { colspan: String(columns.length) });
    detail.appendChild(panelCell);
    var open = false;
    var built = false;
    var toggle = function () {
      open = !open;
      summary.setAttribute('aria-expanded', open ? 'true' : 'false');
      summary.classList.toggle('open', open);
      detail.hidden = !open;
      if (open && !built) {
        panelCell.appendChild(renderTaskPanel(source));
        built = true;
      }
    };
    summary.addEventListener('click', toggle);
    summary.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    summary.appendChild(td(mono(source.taskId)));
    summary.appendChild(td(textOrNa(source.category)));
    summary.appendChild(td(textOrNa(source.difficulty)));
    summary.appendChild(td(textOrNa(source.scenarioType)));
    summary.appendChild(td(outcomeNode(source.outcome)));
    summary.appendChild(tdNum(formatMs(source.durationMs)));
    summary.appendChild(tdNum(source.retries == null ? 'n/a' : String(source.retries)));
    summary.appendChild(td(textOrNa(source.failureReason), 'wrap'));
    table.tbody.appendChild(summary);
    table.tbody.appendChild(detail);
  });
  return table.wrap;
}

function runPage(run, requestedId) {
  var dataset = run.dataset || {};
  var agent = run.agent || {};
  var scenario = run.scenario || {};
  var interpretation = run.interpretation || {};
  var page = el('div', { class: 'page' });
  var header = el('header', { class: 'page-header' });
  header.appendChild(el('div', { class: 'kicker' }, 'Run'));
  var title = el('h1', { class: 'mono break' });
  title.textContent = run.id ? String(run.id) : String(requestedId);
  header.appendChild(title);
  var meta = el('div', { class: 'meta' });
  meta.appendChild(badge(run.status ? String(run.status) : 'n/a', 'status'));
  var started = el('span');
  started.appendChild(document.createTextNode('Started '));
  started.appendChild(timeText(run.startedAt));
  var ended = el('span');
  ended.appendChild(document.createTextNode('Ended '));
  ended.appendChild(timeText(run.endedAt));
  var duration = el('span');
  duration.textContent = 'Duration ' + formatMs(run.durationMs);
  meta.appendChild(started);
  meta.appendChild(ended);
  meta.appendChild(duration);
  meta.appendChild(button('All runs', 'btn', function () { go('#/runs'); }));
  header.appendChild(meta);
  page.appendChild(header);

  if (typeof interpretation.note === 'string' && interpretation.note.trim()) {
    var note = el('div', { class: 'callout note' });
    note.appendChild(el('div', { class: 'kicker' }, 'Interpretation'));
    var noteText = el('p');
    noteText.textContent = interpretation.note;
    note.appendChild(noteText);
    page.appendChild(note);
  }
  if (dataset.synthetic || interpretation.syntheticData) page.appendChild(syntheticBanner(dataset.label));
  if (agent.usesAnswerKey) {
    page.appendChild(warningCallout('Scripted test double. It can read answer keys. These figures are not model quality.'));
  }
  if (interpretation.modelOutputDeterminism === 'not_guaranteed') {
    var determinism = el('div', { class: 'callout' });
    var determinismText = el('p');
    determinismText.textContent = 'Configuration can be reproduced. Provider outputs are not guaranteed to repeat.';
    determinism.appendChild(determinismText);
    page.appendChild(determinism);
  }
  if (run.interpretation) {
    var interpretationCard = el('section', { class: 'card stack' });
    interpretationCard.appendChild(el('h2', null, 'Interpretation'));
    interpretationCard.appendChild(kv([
      ['Synthetic data', formatBool(interpretation.syntheticData)],
      ['Agent uses answer key', formatBool(interpretation.agentUsesAnswerKey)],
      ['Deterministic agent', formatBool(interpretation.deterministicAgent)],
      ['Evaluation class', textOrNa(interpretation.evaluationClass)],
      ['Model output determinism', textOrNa(interpretation.modelOutputDeterminism)]
    ]));
    page.appendChild(interpretationCard);
  }

  var datasetCard = el('section', { class: 'card stack' });
  datasetCard.appendChild(el('h2', null, 'Dataset'));
  datasetCard.appendChild(kv([
    ['Path', mono(dataset.path, 'break')],
    ['Version', mono(dataset.version)],
    ['Checksum', mono(dataset.checksum, 'break')],
    ['Origin', textOrNa(dataset.origin)],
    ['Label', textOrNa(dataset.label)],
    ['Seed', textOrNa(dataset.seed)],
    ['Count', formatCount(dataset.count)],
    ['Synthetic', formatBool(dataset.synthetic)]
  ]));

  var agentCard = el('section', { class: 'card stack' });
  agentCard.appendChild(el('h2', null, 'Agent'));
  agentCard.appendChild(kv([
    ['Name', textOrNa(agent.name)],
    ['Version', textOrNa(agent.version)],
    ['Model', textOrNa(agent.model)],
    ['Provider', textOrNa(agent.provider)],
    ['Uses answer key', formatBool(agent.usesAnswerKey)],
    ['Deterministic', formatBool(agent.deterministic)],
    ['Prompt template', textOrNa(agent.promptTemplateVersion)],
    ['Prompt template sha256', mono(agent.promptTemplateSha256, 'break')]
  ]));
  agentCard.appendChild(configDetails(agent.config));

  var scenarioCard = el('section', { class: 'card stack' });
  scenarioCard.appendChild(el('h2', null, 'Scenario'));
  scenarioCard.appendChild(kv([
    ['Mode', textOrNa(scenario.mode)],
    ['Seed', textOrNa(scenario.seed)],
    ['Evaluation class', textOrNa(scenario.evaluationClass)]
  ]));
  scenarioCard.appendChild(el('h3', null, 'Faults'));
  scenarioCard.appendChild(faultsNode(scenario.faults));

  var provenance = el('section', { class: 'card stack' });
  provenance.appendChild(el('h2', null, 'Provenance'));
  provenance.appendChild(kv([
    ['Status', textOrNa(run.status)],
    ['Run seed', textOrNa(run.seed)],
    ['Started', timeText(run.startedAt)],
    ['Ended', timeText(run.endedAt)],
    ['Duration', formatMs(run.durationMs)],
    ['Git commit', mono(run.gitCommit, 'break')],
    ['Metric definitions', mono(run.metricDefinitionsVersion, 'break')],
    ['Evaluation code', mono(run.evaluationCodeVersion, 'break')],
    ['Environment', formatEnv(run.environment)]
  ]));
  provenance.appendChild(el('h3', null, 'Limits'));
  provenance.appendChild(run.limits == null ? paragraph('n/a') : jsonPre(run.limits));

  var cols = el('div', { class: 'cols' });
  cols.appendChild(datasetCard);
  cols.appendChild(agentCard);
  cols.appendChild(scenarioCard);
  cols.appendChild(provenance);
  page.appendChild(cols);
  page.appendChild(metricsSection(run.metrics));

  var tasks = el('section', { class: 'stack' });
  tasks.appendChild(el('h2', null, 'Tasks'));
  if (run.tasks == null) tasks.appendChild(renderTaskTable([]));
  else if (!Array.isArray(run.tasks)) {
    tasks.appendChild(paragraph('Tasks were not returned as a list.'));
    tasks.appendChild(jsonPre(run.tasks));
  } else tasks.appendChild(renderTaskTable(run.tasks));
  page.appendChild(tasks);
  return page;
}

function pairProblem(baseline, candidate) {
  if (!baseline || !candidate) return 'Select a baseline run and a candidate run.';
  if (baseline === candidate) return 'Choose two different runs.';
  return '';
}

function compareLinks(baseline, candidate) {
  var p = el('p');
  p.appendChild(document.createTextNode('Baseline '));
  p.appendChild(baseline ? runLink(baseline) : document.createTextNode('n/a'));
  p.appendChild(document.createTextNode(' · Candidate '));
  p.appendChild(candidate ? runLink(candidate) : document.createTextNode('n/a'));
  return p;
}

function declaredBanner(reasons) {
  var box = el('div', { class: 'callout danger', role: 'alert' });
  box.appendChild(el('div', { class: 'kicker' }, 'Regression declared'));
  if (Array.isArray(reasons) && reasons.length) box.appendChild(stringList(reasons));
  else {
    var p = el('p');
    p.textContent = 'A regression was declared. No reasons were returned.';
    box.appendChild(p);
  }
  return box;
}

function regressionBlock(reg) {
  if (!reg || typeof reg !== 'object') return paragraph('No regression result was returned.');
  var wrap = el('div', { class: 'stack' });
  if (reg.declared) wrap.appendChild(declaredBanner(reg.reasons));
  if (reg.smallSample) {
    var message = reg.declared
      ? 'The sample is too small for a firm conclusion.'
      : 'A regression was not declared because the sample is too small.';
    wrap.appendChild(warningCallout(message, reg.suppressedReasons));
  } else if (!reg.declared) {
    var calm = el('div', { class: 'callout' });
    var calmText = el('p');
    calmText.textContent = 'No regression declared.';
    calm.appendChild(calmText);
    wrap.appendChild(calm);
  }
  if (!reg.smallSample && Array.isArray(reg.suppressedReasons) && reg.suppressedReasons.length) {
    var extra = el('div', { class: 'callout' });
    extra.appendChild(el('h3', null, 'Suppressed reasons'));
    extra.appendChild(stringList(reg.suppressedReasons));
    wrap.appendChild(extra);
  }
  var warnings = warningsBlock(reg.warnings);
  if (warnings) wrap.appendChild(warnings);
  return wrap;
}

function compareMetrics(data) {
  var table = makeTable('Compared metrics', [
    { label: 'Metric' },
    { label: 'Baseline', num: true },
    { label: 'Candidate', num: true },
    { label: 'Delta', num: true }
  ]);
  var rows = [
    ['Success rate', data.successRate, 'rate', true],
    ['Recovery rate', data.recoveryRate, 'rate', true],
    ['Median latency', data.medianLatencyMs, 'ms', false],
    ['P95 latency', data.p95LatencyMs, 'ms', false],
    ['Estimated cost', data.estimatedCostUsd, 'usd', false]
  ];
  rows.forEach(function (row) {
    var source = row[1] && typeof row[1] === 'object' ? row[1] : {};
    var formatValue = row[2] === 'rate' ? formatRatePercent : row[2] === 'ms' ? formatMs : formatCost;
    var formatDelta = row[2] === 'rate' ? formatSignedRate : row[2] === 'ms' ? formatSignedMs : formatSignedCost;
    var tr = el('tr');
    tr.appendChild(td(row[0]));
    tr.appendChild(tdNum(formatValue(source.baseline)));
    tr.appendChild(tdNum(formatValue(source.candidate)));
    tr.appendChild(tdNum(deltaNode(source.delta, formatDelta(source.delta), row[3])));
    table.tbody.appendChild(tr);
  });
  return table.wrap;
}

function failureCompare(rows) {
  if (rows == null) return paragraph('n/a');
  if (!Array.isArray(rows)) return jsonPre(rows);
  if (!rows.length) return paragraph('No category rates were returned.');
  var table = makeTable('Failure rate by category', [
    { label: 'Category' },
    { label: 'Baseline', num: true },
    { label: 'Candidate', num: true },
    { label: 'Delta', num: true }
  ]);
  rows.forEach(function (row) {
    var source = row || {};
    var tr = el('tr');
    tr.appendChild(td(textOrNa(source.category), 'wrap'));
    tr.appendChild(tdNum(formatRatePercent(source.baseline)));
    tr.appendChild(tdNum(formatRatePercent(source.candidate)));
    tr.appendChild(tdNum(deltaNode(source.delta, formatSignedRate(source.delta), false)));
    table.tbody.appendChild(tr);
  });
  return table.wrap;
}

function countLabel(value) {
  return Array.isArray(value) ? String(value.length) : 'n/a';
}

function outcomeTable(caption, rows, candidateRunId) {
  var table = makeTable(caption, [
    { label: 'Task' },
    { label: 'Baseline' },
    { label: 'Candidate' }
  ]);
  rows.forEach(function (row) {
    var source = row || {};
    var taskCell = el('td');
    if (candidateRunId && source.taskId != null) taskCell.appendChild(taskRunLink(source.taskId, candidateRunId));
    else taskCell.textContent = source.taskId == null ? 'n/a' : String(source.taskId);
    var tr = el('tr');
    tr.appendChild(taskCell);
    tr.appendChild(td(outcomeNode(source.baselineOutcome)));
    tr.appendChild(td(outcomeNode(source.candidateOutcome)));
    table.tbody.appendChild(tr);
  });
  return table.wrap;
}

function outcomeSection(data, candidateId) {
  var section = el('section', { class: 'stack' });
  section.appendChild(el('h2', null, 'Outcomes'));
  var summary = el('p');
  summary.textContent = 'New failures: ' + countLabel(data.newFailures) + '. Resolved failures: ' + countLabel(data.resolvedFailures) + '. Outcome changes: ' + countLabel(data.outcomeChanges) + '.';
  section.appendChild(summary);
  [
    ['New failures', data.newFailures],
    ['Resolved failures', data.resolvedFailures],
    ['Outcome changes', data.outcomeChanges]
  ].forEach(function (entry) {
    if (Array.isArray(entry[1]) && entry[1].length) {
      section.appendChild(el('h3', null, entry[0]));
      section.appendChild(outcomeTable(entry[0], entry[1], candidateId));
    }
  });
  return section;
}

function compareReport(data, baselineFallback, candidateFallback) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return errorBlock(new Error('The compare response was empty.'));
  }
  var baselineId = data.baselineRunId || baselineFallback;
  var candidateId = data.candidateRunId || candidateFallback;
  var wrap = el('div', { class: 'stack' });
  wrap.appendChild(compareLinks(baselineId, candidateId));
  wrap.appendChild(regressionBlock(data.regression));
  if (Array.isArray(data.notes) && data.notes.length) {
    var notes = el('div', { class: 'callout' });
    notes.appendChild(el('div', { class: 'kicker' }, 'Notes'));
    notes.appendChild(stringList(data.notes));
    wrap.appendChild(notes);
  }
  wrap.appendChild(el('h2', null, 'Metrics'));
  wrap.appendChild(compareMetrics(data));
  wrap.appendChild(el('h3', null, 'Failure rate by category'));
  wrap.appendChild(failureCompare(data.failureRateByCategory));
  wrap.appendChild(outcomeSection(data, candidateId));
  if (data.regression && data.regression.thresholds != null) {
    var thresholds = el('section', { class: 'stack' });
    thresholds.appendChild(el('h2', null, 'Thresholds'));
    thresholds.appendChild(jsonPre(data.regression.thresholds));
    wrap.appendChild(thresholds);
  }
  return wrap;
}

function compareBody(runs, ctx) {
  var wrap = el('div', { class: 'stack' });
  if (!runs.length) {
    wrap.appendChild(emptyRuns());
    return wrap;
  }
  var params = ctx.route.params;
  var baselineParam = params.get('baseline') || '';
  var candidateParam = params.get('candidate') || '';
  var selectedBaseline = baselineParam || storageGet('arl.compare.baseline') || '';
  var selectedCandidate = candidateParam || storageGet('arl.compare.candidate') || '';
  var baselineField = el('div', { class: 'field' });
  baselineField.appendChild(el('label', { for: 'baseline-run' }, 'Baseline'));
  var baselineSelect = runSelect(runs, selectedBaseline);
  baselineSelect.id = 'baseline-run';
  baselineField.appendChild(baselineSelect);
  var candidateField = el('div', { class: 'field' });
  candidateField.appendChild(el('label', { for: 'candidate-run' }, 'Candidate'));
  var candidateSelect = runSelect(runs, selectedCandidate);
  candidateSelect.id = 'candidate-run';
  candidateField.appendChild(candidateSelect);
  var formError = el('p', { class: 'form-error fail', hidden: true });
  var compareButton = button('Compare', 'btn primary', function () {
    var problem = pairProblem(baselineSelect.value, candidateSelect.value);
    if (problem) {
      formError.hidden = false;
      formError.textContent = problem;
      return;
    }
    formError.hidden = true;
    storageSet('arl.compare.baseline', baselineSelect.value);
    storageSet('arl.compare.candidate', candidateSelect.value);
    go(buildHash('/compare', { baseline: baselineSelect.value, candidate: candidateSelect.value }));
  });
  var form = el('div', { class: 'toolbar' });
  form.appendChild(baselineField);
  form.appendChild(candidateField);
  form.appendChild(compareButton);
  form.appendChild(formError);
  var result = el('div', { class: 'stack' });
  wrap.appendChild(form);
  wrap.appendChild(result);

  if (!baselineParam || !candidateParam) {
    result.appendChild(paragraph('Choose two runs and compare them.'));
    return wrap;
  }
  var problem = pairProblem(baselineParam, candidateParam);
  if (problem) {
    var message = el('p', { class: 'fail' });
    message.textContent = problem;
    result.appendChild(message);
    return wrap;
  }
  storageSet('arl.compare.baseline', baselineParam);
  storageSet('arl.compare.candidate', candidateParam);
  result.appendChild(compareLinks(baselineParam, candidateParam));
  result.appendChild(el('p', { class: 'loading' }, 'Loading…'));
  fetchJson(withQuery('/api/compare', [['baseline', baselineParam], ['candidate', candidateParam]]), ctx.signal)
    .then(function (data) {
      if (!isCurrent(ctx.token)) return;
      result.replaceChildren(compareReport(data, baselineParam, candidateParam));
    })
    .catch(function (err) {
      if (isAbort(err) || !isCurrent(ctx.token)) return;
      result.replaceChildren(errorBlock(err));
    });
  return wrap;
}

function optionValue(value) {
  if (value == null || value === '') return '__blank__';
  return String(value);
}

function uniqueOptions(cases, key) {
  var map = new Map();
  cases.forEach(function (row) {
    var raw = row ? row[key] : undefined;
    var value = optionValue(raw);
    if (!map.has(value)) map.set(value, value === '__blank__' ? '(blank)' : String(raw));
  });
  return Array.from(map.entries()).map(function (entry) {
    return { value: entry[0], label: entry[1] };
  }).sort(function (a, b) {
    return a.label.localeCompare(b.label, undefined, { numeric: true });
  });
}

function filterBar(cases) {
  var bar = el('div', { class: 'toolbar' });
  var specs = [
    ['category', 'Category'],
    ['difficulty', 'Difficulty'],
    ['scenarioType', 'Scenario']
  ];
  var selects = {};
  specs.forEach(function (spec) {
    var field = el('div', { class: 'field' });
    var id = 'filter-' + spec[0];
    field.appendChild(el('label', { for: id }, spec[1]));
    var select = el('select', { id: id });
    select.appendChild(el('option', { value: '' }, 'All'));
    uniqueOptions(cases, spec[0]).forEach(function (entry) {
      var option = el('option', { value: entry.value });
      option.textContent = entry.label;
      select.appendChild(option);
    });
    selects[spec[0]] = select;
    field.appendChild(select);
    bar.appendChild(field);
  });
  return {
    node: bar,
    matches: function (row) {
      return specs.every(function (spec) {
        var wanted = selects[spec[0]].value;
        if (!wanted) return true;
        return optionValue(row && row[spec[0]]) === wanted;
      });
    },
    onChange: function (fn) {
      specs.forEach(function (spec) { selects[spec[0]].addEventListener('change', fn); });
    }
  };
}

function eventBody(event) {
  if (typeof event === 'string') {
    var pre = el('pre', { class: 'text' });
    pre.textContent = event;
    return pre;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return jsonPre(event);
  var keys = Object.keys(event);
  if (!keys.length) return jsonPre(event);
  var wrap = el('div', { class: 'stack tight' });
  keys.forEach(function (key) {
    var line = el('p');
    var value = event[key];
    var printable = value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    line.textContent = key + ': ' + (printable ? String(value) : stringify(value));
    wrap.appendChild(line);
  });
  return wrap;
}

function generationBlock(gen) {
  var card = el('section', { class: 'card stack' });
  card.appendChild(el('h2', null, 'Generation'));
  if (!gen || typeof gen !== 'object') {
    card.appendChild(paragraph('n/a'));
    return card;
  }
  card.appendChild(kv([
    ['Generator', formatGenerator(gen)],
    ['Version', looseText(gen.version)],
    ['Seed', looseText(gen.seed != null ? gen.seed : gen.datasetSeed)],
    ['Case seed', looseText(gen.caseSeed)],
    ['Dataset version', looseText(gen.datasetVersion)],
    ['Synthetic', formatBool(gen.synthetic)],
    ['Label', looseText(gen.label)]
  ]));
  card.appendChild(el('h3', null, 'Notes'));
  card.appendChild(notesNode(gen.notes));
  return card;
}

function casePanel(caseData, dataset) {
  if (!caseData || typeof caseData !== 'object' || Array.isArray(caseData)) {
    return errorBlock(new Error('The case response was empty.'));
  }
  var wrap = el('div', { class: 'stack' });
  var title = el('h2', { class: 'case-title' });
  title.textContent = caseData.title ? String(caseData.title) : 'Case';
  wrap.appendChild(title);
  if (caseData.synthetic) {
    var caseLabel = dataset && dataset.label ? dataset.label : (caseData.generation && caseData.generation.label);
    wrap.appendChild(syntheticBanner(caseLabel));
  }
  else {
    var flags = el('div', { class: 'flags' });
    flags.appendChild(externalBadge());
    wrap.appendChild(flags);
  }
  wrap.appendChild(kv([
    ['Id', mono(caseData.id)],
    ['Category', textOrNa(caseData.category)],
    ['Difficulty', textOrNa(caseData.difficulty)],
    ['Scenario', textOrNa(caseData.scenarioType)],
    ['Validation', textOrNa(caseData.validationMethod)],
    ['Seed', textOrNa(caseData.seed)],
    ['Case seed', textOrNa(caseData.caseSeed)],
    ['Dataset version', mono(caseData.datasetVersion)],
    ['Origin', textOrNa(caseData.origin)],
    ['Synthetic', formatBool(caseData.synthetic)]
  ]));
  wrap.appendChild(panelBlock('Prompt', richValue(caseData.prompt)));
  wrap.appendChild(panelBlock('Input', richValue(caseData.input)));
  wrap.appendChild(panelBlock('Visible context', richValue(caseData.visibleContext)));
  wrap.appendChild(panelBlock('Hidden context', richValue(caseData.hiddenContext)));
  wrap.appendChild(panelBlock('Expected output', jsonPre(caseData.expectedOutput)));
  wrap.appendChild(panelBlock('Criteria', richValue(caseData.criteria)));
  wrap.appendChild(panelBlock('Faults', richValue(caseData.faults)));
  wrap.appendChild(panelBlock('Expected tool calls', richValue(caseData.expectedToolCalls)));
  wrap.appendChild(panelBlock('Expected recovery', richValue(caseData.expectedRecovery)));
  wrap.appendChild(generationBlock(caseData.generation));
  return wrap;
}

function datasetForm(path) {
  var form = el('form', { class: 'toolbar' });
  var field = el('div', { class: 'field grow' });
  field.appendChild(el('label', { for: 'dataset-path' }, 'Dataset path'));
  var input = el('input', {
    id: 'dataset-path',
    type: 'text',
    name: 'path',
    value: path,
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off'
  });
  field.appendChild(input);
  var formError = el('p', { class: 'form-error fail', hidden: true });
  form.appendChild(field);
  form.appendChild(el('button', { type: 'submit', class: 'btn primary' }, 'Load'));
  form.appendChild(formError);
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var next = input.value.trim();
    if (!next) {
      formError.hidden = false;
      formError.textContent = 'Enter a dataset path.';
      return;
    }
    formError.hidden = true;
    go(buildHash('/datasets', { path: next }));
  });
  return form;
}

function datasetBody(data, requestedPath, ctx) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return errorBlock(new Error('The dataset response was empty.'));
  }
  var wrap = el('div', { class: 'stack' });
  if (data.synthetic) wrap.appendChild(syntheticBanner(data.label));
  else {
    var flags = el('div', { class: 'flags' });
    flags.appendChild(externalBadge());
    wrap.appendChild(flags);
  }
  wrap.appendChild(kv([
    ['Path', mono(data.path || requestedPath, 'break')],
    ['Version', mono(data.version)],
    ['Checksum', mono(data.checksum, 'break')],
    ['Origin', textOrNa(data.origin)],
    ['Seed', textOrNa(data.seed)],
    ['Count', formatCount(data.count)],
    ['Generator', formatGenerator(data.generator)]
  ]));
  if (data.notes != null) wrap.appendChild(panelBlock('Notes', notesNode(data.notes)));

  if (!Array.isArray(data.cases)) {
    wrap.appendChild(paragraph('Cases were not returned as a list.'));
    return wrap;
  }
  var cases = data.cases;
  var filters = filterBar(cases);
  var count = el('p', { class: 'hint' });
  var table = makeTable('Dataset cases', [
    { label: 'Id' },
    { label: 'Title' },
    { label: 'Category' },
    { label: 'Difficulty' },
    { label: 'Scenario' },
    { label: 'Validation' },
    { label: 'Seed' },
    { label: 'Data' }
  ]);
  var caseSlot = el('div', { class: 'case-panel' });
  var selectedId = null;
  var caseToken = 0;

  function draw() {
    var filtered = cases.filter(function (row) { return filters.matches(row); });
    count.textContent = 'Showing ' + filtered.length + ' of ' + cases.length + ' cases.';
    if (!filtered.length) {
      var message = cases.length ? 'No cases match these filters.' : 'This dataset file has no cases.';
      table.tbody.replaceChildren(emptyRow(8, message));
      return;
    }
    var rows = filtered.map(function (row) {
      var tr = el('tr', { class: row && row.id === selectedId ? 'clickable selected' : 'clickable' });
      tr.tabIndex = 0;
      var open = function () { openCase(row); };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      var dataCell = el('td');
      dataCell.appendChild(row && row.synthetic ? badge('Synthetic', 'synthetic') : externalBadge());
      tr.appendChild(td(mono(row && row.id)));
      tr.appendChild(td(textOrNa(row && row.title), 'wrap'));
      tr.appendChild(td(textOrNa(row && row.category)));
      tr.appendChild(td(textOrNa(row && row.difficulty)));
      tr.appendChild(td(textOrNa(row && row.scenarioType)));
      tr.appendChild(td(textOrNa(row && row.validationMethod)));
      tr.appendChild(td(mono(row && row.seed)));
      tr.appendChild(dataCell);
      return tr;
    });
    table.tbody.replaceChildren();
    rows.forEach(function (row) { table.tbody.appendChild(row); });
  }

  function openCase(row) {
    var id = row && row.id;
    selectedId = id;
    draw();
    var my = ++caseToken;
    if (id == null || id === '') {
      caseSlot.replaceChildren(errorBlock(new Error('This case has no id.')));
      return;
    }
    caseSlot.replaceChildren(el('p', { class: 'loading' }, 'Loading case…'));
    fetchJson(withQuery('/api/dataset/case', [['path', requestedPath], ['id', String(id)]]), ctx.signal)
      .then(function (full) {
        if (my !== caseToken || !isCurrent(ctx.token)) return;
        caseSlot.replaceChildren(casePanel(full, data));
        if (caseSlot.scrollIntoView) caseSlot.scrollIntoView({ block: 'nearest' });
      })
      .catch(function (err) {
        if (isAbort(err) || my !== caseToken || !isCurrent(ctx.token)) return;
        caseSlot.replaceChildren(errorBlock(err));
      });
  }

  filters.onChange(draw);
  wrap.appendChild(filters.node);
  wrap.appendChild(count);
  wrap.appendChild(table.wrap);
  wrap.appendChild(caseSlot);
  draw();
  return wrap;
}

function retryText(retry) {
  if (!retry || typeof retry !== 'object') return 'n/a';
  return formatCount(retry.total) + ' total · mean ' + formatMaybe(retry.meanPerEvaluatedTask, 2);
}

function reliabilityReport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return errorBlock(new Error('The reliability response was empty.'));
  }
  var wrap = el('div', { class: 'stack' });
  wrap.appendChild(el('h2', null, 'Run reliability'));
  var line = el('p');
  line.appendChild(document.createTextNode('Run '));
  line.appendChild(data.runId ? runLink(data.runId) : document.createTextNode('n/a'));
  if (data.evaluated != null) line.appendChild(document.createTextNode(' · Evaluated ' + formatCount(data.evaluated)));
  wrap.appendChild(line);
  if (data.smallSample) wrap.appendChild(warningCallout('The sample is too small for a firm conclusion.'));
  var warnings = warningsBlock(data.warnings);
  if (warnings) wrap.appendChild(warnings);
  var stats = el('div', { class: 'stats' });
  stats.appendChild(statCard('Recovery success', rateNode(data.recoverySuccessRate)));
  stats.appendChild(statCard('Timeout rate', rateNode(data.timeoutRate)));
  stats.appendChild(statCard('Retries', retryText(data.retryCount)));
  wrap.appendChild(stats);
  wrap.appendChild(el('h3', null, 'Failure rate by category'));
  wrap.appendChild(failureBars(data.failureRateByCategory, 'bad'));
  return wrap;
}

function outcomesText(task, runIds) {
  var outcomes = Array.isArray(task.outcomes) ? task.outcomes : [];
  if (!outcomes.length) return 'n/a';
  if (runIds.length && runIds.length === outcomes.length) {
    return outcomes.map(function (outcome, index) {
      return String(runIds[index]) + ': ' + String(outcome);
    }).join(', ');
  }
  return outcomes.map(function (outcome) { return String(outcome); }).join(', ');
}

function variationReport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return errorBlock(new Error('The variation response was empty.'));
  }
  var wrap = el('div', { class: 'stack' });
  wrap.appendChild(el('h2', null, 'Variation'));
  var sig = el('p', { class: 'sig' });
  sig.textContent = 'Statistical significance: not assessed';
  wrap.appendChild(sig);
  if (typeof data.note === 'string' && data.note) {
    var note = el('div', { class: 'callout note' });
    var noteText = el('p');
    noteText.textContent = data.note;
    note.appendChild(noteText);
    wrap.appendChild(note);
  }
  var runIds = Array.isArray(data.runIds) ? data.runIds : [];
  var ids = el('p');
  ids.appendChild(document.createTextNode('Runs '));
  var span = el('span', { class: 'mono break' });
  span.textContent = runIds.length ? runIds.map(function (id) { return String(id); }).join(', ') : 'n/a';
  ids.appendChild(span);
  wrap.appendChild(ids);
  var tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (!tasks.length) {
    wrap.appendChild(paragraph('No per-task rows were returned.'));
    return wrap;
  }
  var table = makeTable('Per-task variation', [
    { label: 'Task' },
    { label: 'Runs', num: true },
    { label: 'Successes', num: true },
    { label: 'Outcomes' },
    { label: 'Latency min', num: true },
    { label: 'Latency max', num: true }
  ]);
  tasks.forEach(function (task) {
    var source = task || {};
    var latency = source.latencyMs || {};
    var tr = el('tr');
    tr.appendChild(td(mono(source.taskId)));
    tr.appendChild(tdNum(formatCount(source.runs)));
    tr.appendChild(tdNum(formatCount(source.successes)));
    tr.appendChild(td(outcomesText(source, runIds), 'wrap'));
    tr.appendChild(tdNum(formatMs(latency.min)));
    tr.appendChild(tdNum(formatMs(latency.max)));
    table.tbody.appendChild(tr);
  });
  wrap.appendChild(table.wrap);
  return wrap;
}

function reliabilityHash(runId, ids) {
  var query = {};
  if (runId) query.run = runId;
  if (ids && ids.length) query.runs = ids.join(',');
  return buildHash('/reliability', query);
}

function reliabilityBody(runs, ctx) {
  var wrap = el('div', { class: 'stack' });
  if (!runs.length) {
    wrap.appendChild(emptyRuns());
    return wrap;
  }
  var params = ctx.route.params;
  var selectedRun = params.get('run') || '';
  var selectedVariation = (params.get('runs') || '').split(',').map(function (part) { return part.trim(); }).filter(Boolean);
  var runField = el('div', { class: 'field' });
  runField.appendChild(el('label', { for: 'reliability-run' }, 'Run'));
  var select = runSelect(runs, selectedRun);
  select.id = 'reliability-run';
  runField.appendChild(select);
  var checks = el('div', { class: 'check-list' });
  runs.forEach(function (run) {
    if (!run || run.id == null || run.id === '') return;
    var label = el('label');
    var input = el('input', { type: 'checkbox' });
    input.value = String(run.id);
    input.checked = selectedVariation.indexOf(String(run.id)) !== -1;
    var span = el('span');
    span.textContent = runOptionLabel(run);
    label.appendChild(input);
    label.appendChild(span);
    checks.appendChild(label);
  });
  var count = el('span', { class: 'hint' });
  function checkedIds() {
    var ids = [];
    checks.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
      if (input.checked) ids.push(input.value);
    });
    return ids;
  }
  function updateCount() {
    count.textContent = checkedIds().length + ' selected';
  }
  checks.addEventListener('change', updateCount);
  updateCount();
  var formError = el('p', { class: 'form-error fail', hidden: true });
  var loadButton = button('Load variation', 'btn primary', function () {
    var ids = checkedIds();
    if (ids.length < 2) {
      formError.hidden = false;
      formError.textContent = 'Select at least two runs.';
      return;
    }
    formError.hidden = true;
    go(reliabilityHash(select.value, ids));
  });
  select.addEventListener('change', function () {
    go(reliabilityHash(select.value, checkedIds()));
  });
  var runRow = el('div', { class: 'toolbar' });
  runRow.appendChild(runField);
  var variationControls = el('div', { class: 'stack' });
  variationControls.appendChild(el('h2', null, 'Variation'));
  variationControls.appendChild(el('p', { class: 'hint' }, 'Select two or more runs.'));
  variationControls.appendChild(checks);
  var actions = el('div', { class: 'toolbar' });
  actions.appendChild(loadButton);
  actions.appendChild(count);
  actions.appendChild(formError);
  variationControls.appendChild(actions);
  var reportSlot = el('div', { class: 'stack' });
  var variationSlot = el('div', { class: 'stack' });
  wrap.appendChild(runRow);
  wrap.appendChild(reportSlot);
  wrap.appendChild(variationControls);
  wrap.appendChild(variationSlot);

  if (selectedRun) {
    reportSlot.appendChild(el('p', { class: 'loading' }, 'Loading…'));
    fetchJson(withQuery('/api/reliability', [['run', selectedRun]]), ctx.signal)
      .then(function (data) {
        if (!isCurrent(ctx.token)) return;
        reportSlot.replaceChildren(reliabilityReport(data));
      })
      .catch(function (err) {
        if (isAbort(err) || !isCurrent(ctx.token)) return;
        reportSlot.replaceChildren(errorBlock(err));
      });
  } else {
    reportSlot.appendChild(paragraph('Select a run to load failure rates.'));
  }

  if (selectedVariation.length >= 2) {
    variationSlot.appendChild(el('p', { class: 'loading' }, 'Loading variation…'));
    fetchJson(variationPath(selectedVariation), ctx.signal)
      .then(function (data) {
        if (!isCurrent(ctx.token)) return;
        variationSlot.replaceChildren(variationReport(data));
      })
      .catch(function (err) {
        if (isAbort(err) || !isCurrent(ctx.token)) return;
        variationSlot.replaceChildren(errorBlock(err));
      });
  } else if (selectedVariation.length === 1) {
    var tooFew = el('p', { class: 'fail' });
    tooFew.textContent = 'Select at least two runs.';
    variationSlot.appendChild(tooFew);
  }
  return wrap;
}

function unknownPage(route) {
  var page = el('div', { class: 'page' });
  page.appendChild(pageHeader('Page not found'));
  var p = el('p', { class: 'lede' });
  p.appendChild(document.createTextNode('No view for '));
  var code = el('code');
  code.textContent = route.path || location.hash || '/';
  p.appendChild(code);
  p.appendChild(document.createTextNode('.'));
  page.appendChild(p);
  page.appendChild(button('Back to overview', 'btn primary', function () { go('#/'); }));
  return page;
}

async function renderOverview(main, ctx) {
  var overviewPromise = settle(fetchJson('/api/overview', ctx.signal));
  var definitionsPromise = settle(fetchJson('/api/definitions', ctx.signal));
  var overviewSettled = await overviewPromise;
  var definitionsSettled = await definitionsPromise;
  if (!isCurrent(ctx.token)) return;
  if (!overviewSettled.ok) {
    if (isAbort(overviewSettled.err)) return;
    throw overviewSettled.err;
  }
  var overview = overviewSettled.data;
  if (!overview || typeof overview !== 'object' || Array.isArray(overview)) {
    throw new Error('The overview response was empty.');
  }
  var definitions = null;
  var definitionsError = null;
  if (!definitionsSettled.ok) {
    if (isAbort(definitionsSettled.err)) return;
    definitionsError = definitionsSettled.err && definitionsSettled.err.message ? definitionsSettled.err.message : 'Request failed';
  } else if (!Array.isArray(definitionsSettled.data)) {
    definitionsError = 'The definitions response was not a list.';
  } else definitions = definitionsSettled.data;
  if (!isCurrent(ctx.token)) return;
  main.replaceChildren(overviewPage(overview, definitions, definitionsError));
}

async function renderRuns(main, ctx) {
  var payload = await fetchJson('/api/runs', ctx.signal);
  if (!isCurrent(ctx.token)) return;
  main.replaceChildren(runsPage(requireRuns(payload)));
}

async function renderRun(main, ctx) {
  var run = await fetchJson('/api/runs/' + encodeURIComponent(ctx.route.id), ctx.signal);
  if (!isCurrent(ctx.token)) return;
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('The run response was empty.');
  main.replaceChildren(runPage(run, ctx.route.id));
}

async function renderCompare(main, ctx) {
  var page = el('div', { class: 'page' });
  page.appendChild(pageHeader('Compare', 'Compare two recorded runs.'));
  var slot = el('div', { class: 'stack' });
  page.appendChild(slot);
  main.replaceChildren(page);
  slot.appendChild(el('p', { class: 'loading' }, 'Loading…'));
  try {
    var payload = await fetchJson('/api/runs', ctx.signal);
    if (!isCurrent(ctx.token)) return;
    slot.replaceChildren(compareBody(requireRuns(payload), ctx));
  } catch (err) {
    if (isAbort(err)) throw err;
    if (!isCurrent(ctx.token)) return;
    slot.replaceChildren(errorBlock(err));
  }
}

async function renderDatasets(main, ctx) {
  var requested = (ctx.route.params.get('path') || '').trim() || DEFAULT_DATASET;
  var page = el('div', { class: 'page' });
  page.appendChild(pageHeader('Datasets', 'Inspect a dataset file served by the local API.'));
  page.appendChild(datasetForm(requested));
  var slot = el('div', { class: 'stack' });
  page.appendChild(slot);
  main.replaceChildren(page);
  slot.appendChild(el('p', { class: 'loading' }, 'Loading…'));
  try {
    var data = await fetchJson(withQuery('/api/dataset', [['path', requested]]), ctx.signal);
    if (!isCurrent(ctx.token)) return;
    slot.replaceChildren(datasetBody(data, requested, ctx));
  } catch (err) {
    if (isAbort(err)) throw err;
    if (!isCurrent(ctx.token)) return;
    slot.replaceChildren(errorBlock(err));
  }
}

async function renderReliability(main, ctx) {
  var page = el('div', { class: 'page' });
  page.appendChild(pageHeader('Reliability', 'Failure rates, recovery, and cross-run variation for recorded runs.'));
  var slot = el('div', { class: 'stack' });
  page.appendChild(slot);
  main.replaceChildren(page);
  slot.appendChild(el('p', { class: 'loading' }, 'Loading…'));
  try {
    var payload = await fetchJson('/api/runs', ctx.signal);
    if (!isCurrent(ctx.token)) return;
    slot.replaceChildren(reliabilityBody(requireRuns(payload), ctx));
  } catch (err) {
    if (isAbort(err)) throw err;
    if (!isCurrent(ctx.token)) return;
    slot.replaceChildren(errorBlock(err));
  }
}

function dispatch(main, ctx) {
  var view = ctx.route.view;
  if (view === 'overview') return renderOverview(main, ctx);
  if (view === 'runs') return renderRuns(main, ctx);
  if (view === 'run') return renderRun(main, ctx);
  if (view === 'compare') return renderCompare(main, ctx);
  if (view === 'datasets') return renderDatasets(main, ctx);
  if (view === 'reliability') return renderReliability(main, ctx);
  main.replaceChildren(unknownPage(ctx.route));
  return null;
}

function render() {
  var token = ++renderToken;
  if (activeController) activeController.abort();
  activeController = new AbortController();
  var route = parseRoute();
  var main = document.getElementById('main');
  updateNav(route);
  document.title = titleFor(route);
  main.setAttribute('aria-busy', 'true');
  main.replaceChildren(el('p', { class: 'loading' }, 'Loading…'));
  var ctx = { token: token, signal: activeController.signal, route: route };
  Promise.resolve(dispatch(main, ctx)).catch(function (err) {
    if (isAbort(err) || !isCurrent(token)) return;
    main.replaceChildren(errorBlock(err));
  }).then(function () {
    if (isCurrent(token)) main.setAttribute('aria-busy', 'false');
  });
}

function boot() {
  document.querySelectorAll('[data-nav]').forEach(function (buttonNode) {
    buttonNode.addEventListener('click', function () {
      var target = buttonNode.getAttribute('data-target');
      if (target) go(target);
    });
  });
  window.addEventListener('hashchange', render);
  if (!location.hash || location.hash === '#') {
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
  render();
}

if (typeof document !== 'undefined') boot();
