/** Machine key from a label: "Målgruppe" → "malgruppe". Matches the API's key pattern. */
export function slugKey(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return s || `tag-${Date.now().toString(36)}`;
}
