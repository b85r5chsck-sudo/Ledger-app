// Cloudflare Pages turns /desktop/index-1.0.7.html into a 308 redirect to
// /desktop/index-1.0.7 ("pretty URLs"). The desktop app downloads its signed
// page update with redirects refused, so that redirect made "Update now" fail.
// This answers /desktop/index-<version>.html directly with a 200 and the page's
// exact bytes. The build stores each page a second time as index-<version>.page,
// which Cloudflare serves unchanged and never redirects.
export async function onRequest({ params, request, env, next }) {
  const m = /^(index-\d+\.\d+\.\d+)\.html$/.exec(String(params.file || ""));
  if (!m || (request.method !== "GET" && request.method !== "HEAD")) return next();
  const u = new URL(request.url);
  u.pathname = "/desktop/" + m[1] + ".page";
  const r = await env.ASSETS.fetch(new Request(u.toString(), { method: request.method }));
  // a missing file comes back as the site's index.html (single-page fallback), never as a .page
  if (r.status !== 200 || /text\/html/i.test(r.headers.get("Content-Type") || "")) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : r.body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
