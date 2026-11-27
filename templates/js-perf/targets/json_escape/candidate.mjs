export function jsonEscape(str) {
  const parts = ['"'];
  const chars = Array.from(str);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const code = ch.codePointAt(0);
    if (code === 0x22) parts.push('\\"');
    else if (code === 0x5c) parts.push('\\\\');
    else if (code === 0x08) parts.push('\\b');
    else if (code === 0x0c) parts.push('\\f');
    else if (code === 0x0a) parts.push('\\n');
    else if (code === 0x0d) parts.push('\\r');
    else if (code === 0x09) parts.push('\\t');
    else if (code < 0x20) parts.push(`\\u${code.toString(16).padStart(4, '0')}`);
    else parts.push(ch);
  }
  parts.push('"');
  return parts.join('');
}
