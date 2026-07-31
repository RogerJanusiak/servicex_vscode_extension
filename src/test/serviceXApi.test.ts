import * as assert from 'assert';
import { ServiceXApi, NotFoundError } from '../serviceXApi';

interface FakeResponse {
  status: number;
  body: any;
}

function makeJwt(expEpochSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expEpochSeconds })).toString('base64');
  return `header.${payload}.signature`;
}

/** Records every call and returns queued responses in order, one per call. */
function mockFetch(responses: FakeResponse[]): { calls: { url: string; init?: any }[] } {
  const calls: { url: string; init?: any }[] = [];
  let i = 0;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  return { calls };
}

suite('serviceXApi.ts', () => {
  const originalFetch = globalThis.fetch;

  teardown(() => {
    globalThis.fetch = originalFetch;
  });

  test('getTransformStatus refreshes a token then fetches the status', async () => {
    const accessToken = makeJwt(Date.now() / 1000 + 3600);
    const { calls } = mockFetch([
      { status: 200, body: { access_token: accessToken } },
      {
        status: 200,
        body: {
          request_id: 'req-1',
          title: 'My Sample',
          status: 'Complete',
          'submit-time': '2026-01-01T00:00:00Z',
          'finish-time': '2026-01-01T01:00:00Z',
          files: 10,
          'files-completed': 9,
          'files-failed': 1,
        },
      },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');
    const status = await api.getTransformStatus('req-1');

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].url, 'https://example.org/token/refresh');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer refresh-token');
    assert.strictEqual(calls[1].url, 'https://example.org/servicex/transformation/req-1');
    assert.strictEqual(calls[1].init.headers.Authorization, `Bearer ${accessToken}`);

    assert.strictEqual(status.requestId, 'req-1');
    assert.strictEqual(status.title, 'My Sample');
    assert.strictEqual(status.status, 'Complete');
    assert.strictEqual(status.files, 10);
    assert.strictEqual(status.filesCompleted, 9);
    assert.strictEqual(status.filesFailed, 1);
    assert.strictEqual(status.submitTime?.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.strictEqual(status.finishTime?.toISOString(), '2026-01-01T01:00:00.000Z');
  });

  test('getTransformStatus treats a "None" finish-time as not finished', async () => {
    mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } },
      {
        status: 200,
        body: {
          request_id: 'req-1',
          status: 'Running',
          'submit-time': '2026-01-01T00:00:00Z',
          'finish-time': 'None',
          files: 10,
          'files-completed': 0,
          'files-failed': 0,
        },
      },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');
    const status = await api.getTransformStatus('req-1');

    assert.strictEqual(status.finishTime, undefined);
  });

  test('getTransformStatus reuses a still-valid cached token instead of refreshing again', async () => {
    const { calls } = mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } },
      {
        status: 200,
        body: { request_id: 'req-1', status: 'Complete', files: 1, 'files-completed': 1, 'files-failed': 0 },
      },
      {
        status: 200,
        body: { request_id: 'req-2', status: 'Complete', files: 1, 'files-completed': 1, 'files-failed': 0 },
      },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');
    await api.getTransformStatus('req-1');
    await api.getTransformStatus('req-2');

    // Only one token refresh call total, even though getTransformStatus was
    // called twice - the second call should reuse the cached access token.
    const refreshCalls = calls.filter((c) => c.url.endsWith('/token/refresh'));
    assert.strictEqual(refreshCalls.length, 1);
    assert.strictEqual(calls.length, 3);
  });

  test('getTransformStatus retries once on a 401 by forcing a fresh token', async () => {
    const { calls } = mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } }, // initial refresh
      { status: 401, body: {} }, // first attempt rejected
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } }, // forced re-refresh
      {
        status: 200,
        body: { request_id: 'req-1', status: 'Complete', files: 1, 'files-completed': 1, 'files-failed': 0 },
      }, // retried attempt succeeds
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');
    const status = await api.getTransformStatus('req-1');

    assert.strictEqual(status.status, 'Complete');
    assert.strictEqual(calls.length, 4);
  });

  test('getTransformStatus throws NotFoundError on a 404', async () => {
    mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } },
      { status: 404, body: { message: 'not found' } },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');

    await assert.rejects(() => api.getTransformStatus('missing'), NotFoundError);
  });

  test('getTransformStatus throws a plain Error on other failure statuses', async () => {
    mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } },
      { status: 500, body: { message: 'boom' } },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');

    await assert.rejects(() => api.getTransformStatus('req-1'), (err: unknown) => {
      assert.ok(err instanceof Error && !(err instanceof NotFoundError));
      assert.match((err as Error).message, /ServiceX WebAPI error 500/);
      return true;
    });
  });

  test('getTransformStatus throws when the token refresh itself is rejected', async () => {
    mockFetch([{ status: 500, body: {} }]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');

    await assert.rejects(
      () => api.getTransformStatus('req-1'),
      /ServiceX access token request rejected \[500\]/
    );
  });

  test('getTransformStatus throws when there is no refresh token configured', async () => {
    mockFetch([]);
    const api = new ServiceXApi('https://example.org', undefined);

    await assert.rejects(
      () => api.getTransformStatus('req-1'),
      /No refresh token configured/
    );
  });

  test('getAllTransforms fetches the plural endpoint and unwraps the "requests" array', async () => {
    const { calls } = mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } },
      {
        status: 200,
        body: {
          requests: [
            { request_id: 'req-1', status: 'Complete', files: 1, 'files-completed': 1, 'files-failed': 0 },
            { request_id: 'req-2', status: 'Running', files: 4, 'files-completed': 2, 'files-failed': 0 },
          ],
        },
      },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');
    const statuses = await api.getAllTransforms();

    assert.strictEqual(calls[1].url, 'https://example.org/servicex/transformation');
    assert.strictEqual(statuses.length, 2);
    assert.deepStrictEqual(statuses.map((s) => s.requestId), ['req-1', 'req-2']);
    assert.strictEqual(statuses[1].status, 'Running');
  });

  test('getAllTransforms returns [] when the backend reports no requests', async () => {
    mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } },
      { status: 200, body: { requests: [] } },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');

    assert.deepStrictEqual(await api.getAllTransforms(), []);
  });

  test('getAllTransforms throws a plain Error on a failure status', async () => {
    mockFetch([
      { status: 200, body: { access_token: makeJwt(Date.now() / 1000 + 3600) } },
      { status: 500, body: { message: 'boom' } },
    ]);

    const api = new ServiceXApi('https://example.org', 'refresh-token');

    await assert.rejects(() => api.getAllTransforms(), /ServiceX WebAPI error 500/);
  });
});
