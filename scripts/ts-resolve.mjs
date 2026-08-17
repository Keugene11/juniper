/**
 * Node's ESM resolver requires explicit file extensions; Next's bundler does
 * not, and the app code is written in Next's style. This hook lets the
 * standalone scripts import the same modules by trying `.ts` (then
 * `/index.ts`) for extensionless relative specifiers.
 */
export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !/\.[a-z]+$/i.test(specifier)) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await next(candidate, context);
      } catch {
        // fall through to the next candidate
      }
    }
  }
  return next(specifier, context);
}
