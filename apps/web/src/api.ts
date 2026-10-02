/** Bundled Android assets have a local origin; data always belongs to this server. */
export function createApiUrl(origin?: string): (path: string) => string {
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('Invalid application origin');
  }
  return path => {
    if (!path.startsWith('/api/') || path.includes('\\') || /[?#]/u.test(path) || new URL(path, 'https://local.test').pathname !== path) throw new Error('Invalid API path');
    return origin ? `${origin}${path}` : path;
  };
}
export const mobileBuild = import.meta.env?.VITE_MDC_MOBILE === 'true';
export const apiUrl = createApiUrl(mobileBuild ? import.meta.env.VITE_MDC_APP_ORIGIN : undefined);
