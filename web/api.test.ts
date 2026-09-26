import {
  describe, expect, it, vi,
} from 'vitest';
import { apiFetch, createAuthenticatedFetch } from './api';

describe('createAuthenticatedFetch', () => {
  it('authenticates with the App Bridge 4 idToken API', async () => {
    const idToken = vi.fn().mockResolvedValue('session-token');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    const authenticatedFetch = createAuthenticatedFetch(
      { idToken },
      fetchImpl,
    );

    await authenticatedFetch('/api/example', {
      headers: { Accept: 'application/json' },
    });

    expect(idToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [uri, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(uri).toBe('/api/example');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer session-token');
  });
});

describe('apiFetch error reporting', () => {
  const errorResponse = (status: number, body: unknown) => new Response(
    JSON.stringify(body),
    { status, statusText: 'Bad Gateway', headers: { 'Content-Type': 'application/json' } },
  );

  it('surfaces the Worker\'s error message instead of only the status code', async () => {
    const f = vi.fn().mockResolvedValue(
      errorResponse(502, { error: 'Bundle updated but composition_v2 write failed: denied' }),
    );

    await expect(apiFetch(f, '/api/bundles/b1', { method: 'PUT' })).rejects.toThrow(
      /composition_v2 write failed: denied/,
    );
  });

  it('keeps the `failed: <status>` prefix that 404 detection relies on', async () => {
    const f = vi.fn().mockResolvedValue(errorResponse(404, { error: 'Bundle not found' }));

    await expect(apiFetch(f, '/api/bundles/ghost')).rejects.toThrow(/failed: 404\b/);
  });

  it('falls back to the status line when the body is not JSON', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response('<html>gateway exploded</html>', { status: 502, statusText: 'Bad Gateway' }),
    );

    await expect(apiFetch(f, '/api/bundles/b1')).rejects.toThrow(/failed: 502 Bad Gateway/);
  });
});
