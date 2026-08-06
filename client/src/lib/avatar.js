// Stable per-guest fallback color for initial avatars — shared by the map
// markers and the Friends & Privacy list so a guest looks the same in both.
export const AVATAR_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#c0392b',
];

export function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
