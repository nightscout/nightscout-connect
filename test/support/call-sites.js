'use strict';

// Blank out comments, string contents and regex literals so a scan for call
// sites only sees code. The output has the same length and line breaks as the
// input, so match positions map back to source lines.
function codeOnly (source) {
  let out = '';
  let i = 0;
  let last = ''; // last significant code character, to tell a regex from division
  const stack = []; // open template literals: brace depth inside each ${ }
  function regexCanStart () {
    if (!last || '(,=:[!&|?{};+-*%<>~^'.includes(last)) return true;
    return /\b(return|typeof|case|do|else|in|of|void|yield|await)\s*$/.test(out);
  }
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (c === '/' && next !== '/' && next !== '*' && regexCanStart()) {
      out += c; i++;
      let inClass = false;
      while (i < source.length && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') { out += ' '; i++; }
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        out += ' '; i++;
      }
      if (source[i] === '/') { out += '/'; i++; }
      last = '/';
    } else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
    } else if (c === '\'' || c === '"') {
      out += c; i++;
      while (i < source.length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') { out += ' '; i++; }
        out += ' '; i++;
      }
      // A quote inside a regex literal can open a "string" that ends at the
      // line break; keep the break so line numbers stay right.
      if (source[i] === c) { out += c; i++; }
      last = c;
    } else if (c === '`' || (c === '}' && stack.length && stack[stack.length - 1] === 0)) {
      if (c === '}') stack.pop();
      out += c; i++;
      while (i < source.length && source[i] !== '`' && !(source[i] === '$' && source[i + 1] === '{')) {
        if (source[i] === '\\') { out += ' '; i++; }
        out += source[i] === '\n' ? '\n' : ' '; i++;
      }
      if (source[i] === '$') { out += '${'; i += 2; stack.push(0); last = '{'; }
      else { out += '`'; i++; last = '`'; }
    } else {
      if (stack.length && c === '{') stack[stack.length - 1]++;
      if (stack.length && c === '}') stack[stack.length - 1]--;
      if (!/\s/.test(c)) last = c;
      out += c; i++;
    }
  }
  return out;
}

const PATTERNS = [
  { name: 'console call', re: /\bconsole\s*\.\s*[A-Za-z_$]+\s*\(/g },
  { name: 'bare actions.log()', re: /\bactions\s*\.\s*log\s*\(\s*\)/g }
];

function findCallSites (source) {
  const code = codeOnly(source);
  const found = [];
  for (const { name, re } of PATTERNS) {
    for (const match of code.matchAll(re)) {
      found.push({ name, line: code.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

module.exports = { codeOnly, findCallSites };
