const STUB = new URL('./vendor-stub.js', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/vendor/')) return { url: STUB, shortCircuit: true, format: 'module' };
  return next(specifier, context);
}
