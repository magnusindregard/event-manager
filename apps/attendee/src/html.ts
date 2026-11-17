// Minimal server-rendered HTML: no client JavaScript, so the pages work everywhere and the
// content security policy can forbid scripts outright.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escaped text. Use raw() only for markup this app builds itself. */
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);

export interface Raw {
  readonly __html: string;
}
export const raw = (html: string): Raw => ({ __html: html });

/** Tagged template that escapes every interpolation except Raw values and arrays of them. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]!;
  values.forEach((v, i) => {
    const part = (x: unknown): string => {
      if (x === null || x === undefined || x === false) return "";
      if (Array.isArray(x)) return x.map(part).join("");
      if (typeof x === "object" && "__html" in (x as Raw)) return (x as Raw).__html;
      return esc(x);
    };
    out += part(v) + strings[i + 1]!;
  });
  return raw(out);
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #52525b; --card: #fff; --line: #e4e4e7; --accent: #18181b; --accent-fg: #fff; --ok: #15803d; --warn: #b45309; --bad: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --card: #18181b; --line: #27272a; --accent: #fafafa; --accent-fg: #18181b; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
header { color: var(--muted); font-size: .875rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; gap: 1rem; }
header nav a { color: var(--muted); margin-left: .5rem; }
h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 .5rem; }
h2 { font-size: 1.125rem; margin: 2rem 0 .75rem; }
p { margin: 0 0 1rem; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: .75rem; padding: 1.25rem; margin: 1rem 0; }
.meta { list-style: none; padding: 0; margin: 0 0 1rem; }
.meta li { margin: .25rem 0; }
.status { display: inline-block; font-weight: 600; font-size: .875rem; padding: .125rem .5rem; border-radius: 999px; border: 1px solid currentColor; }
.status.available { color: var(--ok); } .status.few_left { color: var(--warn); } .status.full, .status.closed, .status.cancelled { color: var(--bad); }
label { display: block; font-weight: 500; margin: 1rem 0 .25rem; }
label.check { display: flex; gap: .5rem; align-items: center; font-weight: 400; }
input[type=text], input[type=email] { width: 100%; padding: .625rem .75rem; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: .5rem; }
input[type=checkbox] { width: 1.125rem; height: 1.125rem; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.help { color: var(--muted); font-size: .875rem; margin-top: .25rem; }
button { margin-top: 1.25rem; padding: .625rem 1.25rem; font: inherit; font-weight: 600; border-radius: .5rem; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg); cursor: pointer; }
button.secondary { background: transparent; color: var(--bad); border-color: var(--bad); }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
.actions button { margin-top: 1.25rem; }
fieldset { border: 0; padding: 0; margin: 1rem 0 0; }
legend { font-weight: 500; margin-bottom: .25rem; padding: 0; }
label.option { display: flex; gap: .75rem; align-items: flex-start; font-weight: 400; margin: .5rem 0; padding: .75rem; border: 1px solid var(--line); border-radius: .5rem; cursor: pointer; }
label.option:has(input:disabled) { opacity: .6; cursor: not-allowed; }
label.option input { margin-top: .25rem; width: 1.125rem; height: 1.125rem; flex: none; }
label.option span.when { display: block; font-weight: 500; }
label.option span.where { display: block; color: var(--muted); font-size: .875rem; }
.readonly { padding: .625rem 0 0; }
.notice { border-left: 4px solid var(--ok); padding: .5rem .75rem; margin: 1rem 0; background: var(--card); }
.error { border-left-color: var(--bad); }
.qr { background: #fff; padding: .75rem; border-radius: .5rem; width: 14rem; max-width: 100%; }
.qr svg { display: block; width: 100%; height: auto; }
.hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
img.hero { width: 100%; border-radius: .75rem; margin-bottom: 1rem; }
`;

export function page(opts: { locale: string; title: string; account?: string; langLinks?: { locale: string; href: string }[]; body: Raw }): string {
  return `<!doctype html>${html`<html lang="${opts.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.title}${opts.account ? ` · ${opts.account}` : ""}</title>
<style>${raw(STYLE)}</style>
</head>
<body><main>
<header><span>${opts.account ?? ""}</span>${opts.langLinks?.length ? html`<nav>${opts.langLinks.map((l) => html`<a href="${l.href}" lang="${l.locale}" hreflang="${l.locale}">${l.locale.toUpperCase()}</a>`)}</nav>` : ""}</header>
${opts.body}
</main></body>
</html>`.__html}`;
}
