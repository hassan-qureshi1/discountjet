import {
  describe, expect, it, vi,
} from 'vitest';
import { ApiError, apiFetch, createAuthenticatedFetch } from './api';

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

  it('shows the merchant the Worker\'s message and nothing else', async () => {
    const f = vi.fn().mockResolvedValue(
      errorResponse(400, {
        error: 'This campaign\'s window has already closed. Change the dates before publishing.',
      }),
    );

    const err = await apiFetch(f, '/api/campaigns/46acfa86/publish', { method: 'POST' })
      .catch((e: unknown) => e);

    // Every Banner in web/ renders `error.message` verbatim, so the message
    // IS the merchant-facing copy. A route, a status code and a statusText in
    // there is a developer reading their own plumbing out loud at someone who
    // cannot act on any of it.
    expect((err as Error).message).toBe(
      'This campaign\'s window has already closed. Change the dates before publishing.',
    );
    expect((err as Error).message).not.toMatch(/\/api\//);
    expect((err as Error).message).not.toMatch(/\b400\b/);
  });

  it('keeps the status and path on the error for the console and Bugsnag', async () => {
    const f = vi.fn().mockResolvedValue(
      errorResponse(502, { error: 'Bundle updated but composition_v2 write failed: denied' }),
    );

    const err = await apiFetch(f, '/api/bundles/b1', { method: 'PUT' }).catch((e: unknown) => e);

    // Hidden from the merchant, not discarded — this is what a support ticket
    // is diagnosed from.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).path).toBe('/api/bundles/b1');
    expect((err as ApiError).message).toBe('Bundle updated but composition_v2 write failed: denied');
  });

  it('exposes the status as a field, which is how the detail pages detect a 404', async () => {
    const f = vi.fn().mockResolvedValue(errorResponse(404, { error: 'Bundle not found' }));

    const err = await apiFetch(f, '/api/bundles/ghost').catch((e: unknown) => e);

    // Replaces the old `/failed: 404\b/` regex over the message: the five
    // detail pages now ask the error what it is instead of parsing prose.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it('falls back to a plain sentence when the body carries no message', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response('<html>gateway exploded</html>', { status: 502, statusText: 'Bad Gateway' }),
    );

    const err = await apiFetch(f, '/api/bundles/b1').catch((e: unknown) => e);

    // "502 Bad Gateway" told the merchant nothing they could act on, so it
    // stays on the error object and the banner gets a sentence instead.
    expect((err as Error).message).toBe('Something went wrong. Please try again.');
    expect((err as ApiError).status).toBe(502);
  });

  it('falls back when the body is JSON but has no error key', async () => {
    const f = vi.fn().mockResolvedValue(errorResponse(500, { ok: false }));

    const err = await apiFetch(f, '/api/bundles/b1').catch((e: unknown) => e);

    expect((err as Error).message).toBe('Something went wrong. Please try again.');
  });
});
