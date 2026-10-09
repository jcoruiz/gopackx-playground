import { esc } from './html';

const KEYWORDS = new Set([
  'package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type', 'struct',
  'defer', 'go', 'continue', 'break', 'nil', 'true', 'false', 'switch', 'case', 'default',
]);

const TOKEN = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_]\w*)(?=\()|([A-Za-z_]\w*)/g;

/** Minimal Go highlighter for the generated program: returns escaped HTML. */
export function highlightGo(src: string): string {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    out += esc(src.slice(last, m.index));
    const [tok, com, str, num, call, word] = m;
    if (com) out += `<span class="com">${esc(com)}</span>`;
    else if (str) out += `<span class="str">${esc(str)}</span>`;
    else if (num) out += `<span class="num">${num}</span>`;
    else if (call) out += KEYWORDS.has(call) ? `<span class="kw">${call}</span>` : `<span class="fn">${call}</span>`;
    else if (word && KEYWORDS.has(word)) out += `<span class="kw">${word}</span>`;
    else out += esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(src.slice(last));
}
