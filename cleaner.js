// Caption Cleanup: the part that reads a caption file and fixes it.
// Built-in fixes, applied to caption text lines only:
//   1. "Crew" (any capitalization) becomes "Cru"
//   2. the filler words "um" and "uh" are removed
//   3. "[Music]" is removed
// People can add their own "remove" or "change" fixes on top of these.
// Timestamps, cue numbers, headers, line endings and every other word stay exactly as they were.
// If a caption ends up with no words at all (it was only "[Music]" or "um"), that whole caption is removed.

(function (root) {
  var SBV_TIMING = /^\s*\d+:\d{2}:\d{2}[.,]\d{1,3}\s*,\s*\d+:\d{2}:\d{2}[.,]\d{1,3}\s*$/;
  var FILLER = /^(u+m+|u+h+)([,.!?…]*)$/i;
  var CREW = /\bcrew\b/gi;
  var MUSIC = /\[\s*music\s*\]/gi;

  var BUILT_IN = [
    { id: 'crew', label: '"Crew" changed to "Cru"' },
    { id: 'fillers', label: 'filler words removed' },
    { id: 'music', label: '"[Music]" removed' }
  ];

  function isTiming(line) {
    return line.indexOf('-->') !== -1 || SBV_TIMING.test(line);
  }

  function startTime(line) {
    var t = line.indexOf('-->') !== -1 ? line.split('-->')[0] : line.split(',')[0];
    return t.trim();
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Turn a typed phrase into a search pattern: any capitalization, any amount of space
  // between words, and whole words only (so "um" never matches inside "summer").
  function phraseRegex(phrase) {
    var p = phrase.trim();
    var body = p.split(/\s+/).map(escRegex).join('\\s+');
    var start = /^[A-Za-z0-9]/.test(p) ? "(?<![A-Za-z0-9'])" : '';
    var end = /[A-Za-z0-9]$/.test(p) ? '(?![A-Za-z0-9])' : '';
    return new RegExp(start + body + end, 'gi');
  }

  // Remove every match of a pattern, along with one space next to it.
  function removeMatches(text, re) {
    var count = 0;
    var wrapped = new RegExp('(\\s?)(?:' + re.source + ')(\\s?)', re.flags);
    var result = text.replace(wrapped, function (m, pre, post) {
      count++;
      return pre && post ? ' ' : '';
    });
    return { text: result, count: count };
  }

  // Remove "um" / "uh" words. "yeah um." keeps its period: "yeah."
  function removeFillers(text) {
    var tokens = text.split(/(\s+)/);
    var removed = [];
    var count = 0;
    for (var i = 0; i < tokens.length; i += 2) {
      var m = tokens[i] && tokens[i].match(FILLER);
      if (!m) continue;
      removed[i] = true;
      count++;
      var endPunct = m[2].replace(/,/g, '');
      if (endPunct) {
        for (var j = i - 2; j >= 0; j -= 2) {
          if (!removed[j] && tokens[j]) {
            if (!/[.!?…,;:]$/.test(tokens[j])) tokens[j] += endPunct;
            break;
          }
        }
      }
    }
    if (!count) return { text: text, count: 0 };
    // Each kept word keeps the space right before it, so a dropped word takes its space with it.
    var lead = tokens[0] === '' && tokens.length > 1 ? tokens[1] : '';
    var trail = tokens.length > 1 && tokens[tokens.length - 1] === '' ? tokens[tokens.length - 2] : '';
    var out = '', first = true;
    for (var k = 0; k < tokens.length; k += 2) {
      if (!tokens[k] || removed[k]) continue;
      out += (first ? lead : tokens[k - 1]) + tokens[k];
      first = false;
    }
    if (!first) out += trail;
    return { text: out, count: count };
  }

  // Clean one plain-text piece (no tags) with every rule. Adds to `counts`.
  function cleanText(text, rules, counts) {
    var r;
    // built-in: [Music]
    r = removeMatches(text, MUSIC);
    text = r.text; counts.music = (counts.music || 0) + r.count;
    // built-in: um / uh
    r = removeFillers(text);
    text = r.text; counts.fillers = (counts.fillers || 0) + r.count;
    // built-in: Crew -> Cru
    text = text.replace(CREW, function (c) {
      counts.crew = (counts.crew || 0) + 1;
      return c === c.toUpperCase() ? 'CRU' : 'Cru';
    });
    // the person's own fixes
    rules.forEach(function (rule) {
      var re = phraseRegex(rule.find);
      if (rule.kind === 'remove') {
        r = removeMatches(text, re);
        text = r.text; counts[rule.id] = (counts[rule.id] || 0) + r.count;
      } else {
        text = text.replace(re, function () {
          counts[rule.id] = (counts[rule.id] || 0) + 1;
          return rule.to;
        });
      }
    });
    return text;
  }

  // Clean one caption text line. VTT lines can hold tags like <c> or <00:00:01.200>;
  // those are kept exactly and only the words between them are cleaned.
  function cleanLine(line, rules, counts) {
    var parts = line.split(/(<[^>]*>)/);
    var text = '';
    for (var i = 0; i < parts.length; i++) {
      text += i % 2 === 1 ? parts[i] : cleanText(parts[i], rules, counts);
    }
    if (text !== line) {
      // tidy only the spaces a removal left at the very start or end of the line
      var lead = line.match(/^\s*/)[0];
      var trail = line.match(/\s*$/)[0];
      text = lead + text.trim() + trail;
    }
    return text;
  }

  function plainText(line) {
    return line.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  function isBlankText(line) {
    return plainText(line) === '';
  }

  // Word-by-word comparison so the page can mark what was taken out and what was put in.
  function diffHtml(before, after) {
    var a = before ? before.split(' ') : [];
    var b = after ? after.split(' ') : [];
    var n = a.length, m = b.length;
    var L = [];
    for (var i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    var bh = [], ah = [];
    i = 0; j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { bh.push(esc(a[i])); ah.push(esc(b[j])); i++; j++; }
      else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { ah.push('<ins>' + esc(b[j]) + '</ins>'); j++; }
      else { bh.push('<del>' + esc(a[i]) + '</del>'); i++; }
    }
    return { beforeHtml: bh.join(' '), afterHtml: ah.join(' ') };
  }

  // Main entry. `customRules` is a list of {id, kind: 'remove'|'change', find, to}.
  function processCaptions(raw, fileName, customRules) {
    var rules = (customRules || []).filter(function (r) { return r && r.find && r.find.trim(); });
    var bom = raw.charCodeAt(0) === 0xFEFF ? '﻿' : '';
    var body = bom ? raw.slice(1) : raw;
    var pieces = body.split(/(\r\n|\n|\r)/);
    var lines = [], seps = [];
    for (var i = 0; i < pieces.length; i += 2) {
      lines.push(pieces[i]);
      seps.push(pieces[i + 1] || '');
    }

    // Find each caption: its number line (SRT), its timing line and its text lines.
    var cues = [];
    var cur = null;
    for (var l = 0; l < lines.length; l++) {
      var line = lines[l];
      if (line.trim() === '') { cur = null; continue; }
      if (isTiming(line)) {
        var start = l;
        if (l > 0 && /^\s*\d+\s*$/.test(lines[l - 1]) && (l === 1 || lines[l - 2].trim() === '')) start = l - 1;
        cur = { time: startTime(line), start: start, lines: [] };
        cues.push(cur);
        continue;
      }
      if (cur) cur.lines.push(l);
    }

    var changes = [];
    var totals = {};

    cues.forEach(function (cue) {
      if (!cue.lines.length) return;
      var counts = {};
      var cleaned = cue.lines.map(function (idx) { return cleanLine(lines[idx], rules, counts); });
      var changedAny = cleaned.some(function (t, n) { return t !== lines[cue.lines[n]]; });
      if (!changedAny) return;
      Object.keys(counts).forEach(function (k) { totals[k] = (totals[k] || 0) + counts[k]; });

      var allEmpty = cleaned.every(isBlankText);
      if (allEmpty) {
        // Nothing left in this caption, so the whole caption goes, along with the blank line after it.
        var last = cue.lines[cue.lines.length - 1];
        var drop = [];
        for (var d = cue.start; d <= last; d++) drop.push(d);
        var atEnd = last + 1 >= lines.length - 1 && (lines[lines.length - 1] || '').trim() === '';
        if (!atEnd && lines[last + 1].trim() === '') drop.push(last + 1);
        else if (cue.start > 0 && lines[cue.start - 1].trim() === '') drop.push(cue.start - 1); // last caption in the file
        var beforeText = cue.lines.map(function (idx) { return plainText(lines[idx]); }).join(' ');
        changes.push({
          lineNumber: cue.lines[0] + 1, time: cue.time, wholeCaption: true,
          dropLines: drop, edits: {},
          beforeHtml: diffHtml(beforeText, '').beforeHtml, afterHtml: '',
          keep: true
        });
        return;
      }
      cleaned.forEach(function (t, n) {
        var idx = cue.lines[n];
        if (t === lines[idx]) return;
        var dropLine = isBlankText(t);
        var dh = diffHtml(plainText(lines[idx]), dropLine ? '' : plainText(t));
        var edits = {};
        if (!dropLine) edits[idx] = t;
        changes.push({
          lineNumber: idx + 1, time: cue.time, wholeCaption: false, lineRemoved: dropLine,
          dropLines: dropLine ? [idx] : [], edits: edits,
          beforeHtml: dh.beforeHtml, afterHtml: dh.afterHtml,
          keep: true
        });
      });
    });

    var labels = {};
    BUILT_IN.forEach(function (b) { labels[b.id] = b.label; });
    rules.forEach(function (r) {
      labels[r.id] = r.kind === 'remove' ? '"' + r.find + '" removed' : '"' + r.find + '" changed to "' + r.to + '"';
    });

    return {
      fileName: fileName,
      ext: (fileName.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase(),
      bom: bom, lines: lines, seps: seps,
      looksLikeCaptions: cues.length > 0,
      changes: changes,
      totals: totals,
      labels: labels
    };
  }

  // Put the file back together, using each change only if it is still switched on.
  function buildOutput(result) {
    var drop = {}, edits = {};
    result.changes.forEach(function (c) {
      if (!c.keep) return;
      c.dropLines.forEach(function (i) { drop[i] = true; });
      Object.keys(c.edits).forEach(function (i) { edits[i] = c.edits[i]; });
    });
    var out = result.bom;
    for (var i = 0; i < result.lines.length; i++) {
      if (drop[i]) continue;
      out += (i in edits ? edits[i] : result.lines[i]) + result.seps[i];
    }
    return out;
  }

  var api = { processCaptions: processCaptions, buildOutput: buildOutput };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptionCleaner = api;
})(this);
