// A module resolve hook that maps the front end's one absolute-URL import - '/vendor/...', which
// the dev server serves and Node refuses - onto a local stub. Register it with
// `module.register('./helpers/vendor-hooks.js', import.meta.url)` before importing anything that
// reaches detector.js.
const STUB = new URL('./vendor-stub.js', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/vendor/')) return { url: STUB, shortCircuit: true, format: 'module' };
  return next(specifier, context);
}
