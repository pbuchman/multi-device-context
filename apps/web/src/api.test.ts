import { describe, expect, it } from 'vitest';
import { createApiUrl } from './api.js';
describe('API origins', () => {
  it('keeps browser calls relative and mobile calls on trusted server', () => {
    expect(createApiUrl()('/api/session')).toBe('/api/session');
    expect(createApiUrl('https://contexts.example.com')('/api/session')).toBe('https://contexts.example.com/api/session');
  });
  it('rejects origins with credentials, paths, insecure transport and foreign endpoints', () => {
    for (const origin of ['http://host.test', 'https://user:pass@host.test', 'https://host.test/path']) expect(() => createApiUrl(origin)).toThrow();
    for (const path of ['//attacker.test/api', 'https://attacker.test/api', '/api/../other', '/api/x#token']) expect(() => createApiUrl('https://host.test')(path)).toThrow();
  });
});
