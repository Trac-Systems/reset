// Byte-for-byte compatible with the Intercom sidechannel serializer.
export function stableJSON(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
}
export const stableStringify = stableJSON;

// Bounded JSON reader: malformed input returns undefined, without exceptions.
// Duplicate keys are rejected, including escape-equivalent keys.
export function parseJSON(text, maxLength = 8192) {
  if (typeof text !== 'string' || text.length > maxLength) return undefined;
  let i = 0;
  let bad = false;
  const ws = () => { while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; };
  const string = () => {
    if (text[i++] !== '"') { bad = true; return ''; }
    let out = '';
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return out;
      if (c.charCodeAt(0) < 32) { bad = true; return ''; }
      if (c !== '\\') { out += c; continue; }
      const e = text[i++];
      const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (Object.hasOwn(escapes, e)) out += escapes[e];
      else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) {
        out += String.fromCharCode(Number.parseInt(text.slice(i, i + 4), 16)); i += 4;
      } else { bad = true; return ''; }
    }
    bad = true;
    return '';
  };
  const value = depth => {
    ws();
    if (depth > 16 || i >= text.length) { bad = true; return null; }
    const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      i++; ws();
      const object = c === '{';
      const out = object ? Object.create(null) : [];
      const end = object ? '}' : ']';
      if (text[i] === end) { i++; return out; }
      while (!bad && i < text.length) {
        ws();
        if (object) {
          if (text[i] !== '"') { bad = true; break; }
          const key = string(); ws();
          if (Object.hasOwn(out, key) || text[i++] !== ':') { bad = true; break; }
          out[key] = value(depth + 1);
        } else out.push(value(depth + 1));
        ws();
        if (text[i] === end) { i++; return out; }
        if (text[i++] !== ',') { bad = true; break; }
      }
      bad = true; return null;
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, i)) { i += token.length; return result; }
    }
    const n = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!n || !Number.isFinite(Number(n[0]))) { bad = true; return null; }
    i += n[0].length; return Number(n[0]);
  };
  const result = value(0); ws();
  return bad || i !== text.length ? undefined : result;
}
