// Caption Cleanup: the part that reads a caption file and fixes it.
// It changes only two things inside caption text lines:
//   1. "Crew" (any capitalization) becomes "Cru"
//   2. the filler words "um" and "uh" are removed
// Timestamps, cue numbers, headers, line endings and every other word stay exactly as they were.

(function (root) {
  var SBV_TIMING = /^\s*\d+:\d{2}:\d{2}[.,]\d{1,3}\s*,\s*\d+:\d{2}:\d{2}[.,]\d{1,3}\s*$/;
  var FILLER = /^(u+m+|u+h+)([,.!?…]*)$/i;
  var CREW = /\bcrew\b/gi;

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

  // Clean one plain-text piece (no tags). Returns the new text plus
  // "before" and "after" HTML with the changed words marked.
  function cleanText(text, opts) {
    var tokens = text.split(/(\s+)/); // words at even spots, spaces at odd spots
    var out = tokens.slice();
    var removed = [];
    var fillers = 0, crews = 0;

    for (var i = 0; i < tokens.length; i += 2) {
      var w = tokens[i];
      if (!w) continue;
      var m = opts.fillers && w.match(FILLER);
      if (m) {
        removed[i] = true;
        fillers++;
        var endPunct = m[2].replace(/,/g, '');
        if (endPunct) {
          // "yeah um." -> "yeah." keeps the sentence ending
          for (var j = i - 2; j >= 0; j -= 2) {
            if (!removed[j] && out[j]) {
              if (!/[.!?…,;:]$/.test(out[j])) out[j] = out[j] + endPunct;
              break;
            }
          }
        }
        continue;
      }
      if (CREW.test(w)) {
        CREW.lastIndex = 0;
        out[i] = w.replace(CREW, function (c) {
          crews++;
          return c === c.toUpperCase() ? 'CRU' : 'Cru';
        });
      }
      CREW.lastIndex = 0;
    }

    // Rebuild the new text. Each kept word keeps the space that came right before it,
    // so dropping a word also drops the one space in front of it.
    var result = '', afterHtml = '', beforeHtml = '';
    var anyRemoved = removed.some(Boolean);
    var lead = tokens[0] === '' && tokens.length > 1 ? tokens[1] : '';
    var trail = tokens.length > 1 && tokens[tokens.length - 1] === '' ? tokens[tokens.length - 2] : '';
    var firstKept = true;
    for (var k = 0; k < tokens.length; k += 2) {
      var word = tokens[k];
      if (!word) continue;
      var spaceBefore = k > 0 ? tokens[k - 1] : '';
      beforeHtml += (k > 0 ? spaceBefore : '');
      if (removed[k]) { beforeHtml += '<del>' + esc(word) + '</del>'; continue; }
      var changed = out[k] !== word;
      beforeHtml += changed ? markCrew(word, 'del') : esc(word);
      var sp = firstKept ? lead : spaceBefore;
      result += sp + out[k];
      afterHtml += sp + (changed ? markCrew(out[k], 'ins') : esc(out[k]));
      firstKept = false;
    }
    if (!firstKept) { result += trail; afterHtml += trail; }
    if (!anyRemoved) {
      // nothing removed: keep the original spacing exactly
      result = out.join('');
    }
    return { text: result, beforeHtml: beforeHtml, afterHtml: afterHtml, fillers: fillers, crews: crews };
  }

  function markCrew(word, tag) {
    return esc(word).replace(/\b(crew|cru)\b/gi, '<' + tag + '>$1</' + tag + '>');
  }

  // Clean one caption text line. VTT lines can hold tags like <c> or <00:00:01.200>;
  // those are kept exactly and only the words between them are cleaned.
  function cleanLine(line, opts) {
    var parts = line.split(/(<[^>]*>)/);
    var text = '', before = '', after = '', fillers = 0, crews = 0;
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { text += parts[i]; continue; }
      var r = cleanText(parts[i], opts);
      text += r.text; before += r.beforeHtml; after += r.afterHtml;
      fillers += r.fillers; crews += r.crews;
    }
    // Tidy up only spaces our removals left at the very start or end of the line.
    if (fillers) text = tidyEnds(line, text);
    return { text: text, beforeHtml: before.trim(), afterHtml: after.trim(), fillers: fillers, crews: crews };
  }

  function tidyEnds(original, text) {
    var lead = original.match(/^\s*/)[0];
    var trail = original.match(/\s*$/)[0];
    return lead + text.trim() + trail;
  }

  function isBlankText(line) {
    return line.replace(/<[^>]*>/g, '').trim() === '';
  }

  // Main entry. Returns everything the page needs.
  function processCaptions(raw, fileName) {
    var bom = raw.charCodeAt(0) === 0xFEFF ? '﻿' : '';
    var body = bom ? raw.slice(1) : raw;
    var pieces = body.split(/(\r\n|\n|\r)/);
    var lines = [], seps = [];
    for (var i = 0; i < pieces.length; i += 2) {
      lines.push(pieces[i]);
      seps.push(pieces[i + 1] || '');
    }

    // Group caption text lines into cues.
    var cues = [];
    var cur = null;
    var timingCount = 0;
    for (var l = 0; l < lines.length; l++) {
      var line = lines[l];
      if (line.trim() === '') { cur = null; continue; }
      if (isTiming(line)) {
        timingCount++;
        cur = { time: startTime(line), lines: [] };
        cues.push(cur);
        continue;
      }
      if (cur) cur.lines.push(l);
    }

    var changes = [];
    var totals = { crews: 0, fillers: 0 };
    var skippedOnlyFiller = 0;

    cues.forEach(function (cue) {
      var results = cue.lines.map(function (idx) { return cleanLine(lines[idx], { fillers: true }); });
      var allEmpty = results.length > 0 && results.every(function (r) { return isBlankText(r.text); });
      if (allEmpty) {
        // The whole caption is only "um" or "uh". Removing it would leave an empty caption,
        // so we leave the filler in place and only fix "Crew" here.
        skippedOnlyFiller++;
        results = cue.lines.map(function (idx) { return cleanLine(lines[idx], { fillers: false }); });
      }
      results.forEach(function (r, n) {
        var idx = cue.lines[n];
        if (r.text === lines[idx]) return;
        var dropLine = isBlankText(r.text);
        totals.crews += r.crews; totals.fillers += r.fillers;
        changes.push({
          index: idx,
          lineNumber: idx + 1,
          time: cue.time,
          before: lines[idx],
          after: r.text,
          dropLine: dropLine,
          beforeHtml: r.beforeHtml,
          afterHtml: dropLine ? '' : r.afterHtml,
          crews: r.crews,
          fillers: r.fillers,
          keep: true
        });
      });
    });

    return {
      fileName: fileName,
      ext: (fileName.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase(),
      bom: bom, lines: lines, seps: seps,
      cueCount: cues.length,
      looksLikeCaptions: timingCount > 0,
      changes: changes,
      totals: totals,
      skippedOnlyFiller: skippedOnlyFiller
    };
  }

  // Put the file back together, using each change only if it is still switched on.
  function buildOutput(result) {
    var byIndex = {};
    result.changes.forEach(function (c) { if (c.keep) byIndex[c.index] = c; });
    var out = result.bom;
    for (var i = 0; i < result.lines.length; i++) {
      var c = byIndex[i];
      if (c && c.dropLine) continue; // the line was only filler; drop it and its line break
      out += (c ? c.after : result.lines[i]) + result.seps[i];
    }
    return out;
  }

  var api = { processCaptions: processCaptions, buildOutput: buildOutput, cleanLine: cleanLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptionCleaner = api;
})(this);
