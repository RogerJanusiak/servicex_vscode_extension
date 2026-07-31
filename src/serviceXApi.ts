export class NotFoundError extends Error {}

export interface TransformStatus {
  requestId: string;
  title?: string;
  status: string;
  submitTime?: Date;
  finishTime?: Date;
  files: number;
  filesCompleted: number;
  filesFailed: number;
  /** The query as ServiceX stored it - qastle, base64'd Python, or JSON,
   *  depending on the query type. See queryDecoder.ts. Optional only
   *  defensively: the WebAPI always returns it. */
  selection?: string;
  did?: string;
  resultFormat?: string;
}

function decodeJwtExpiry(token: string): number {
  const payload = token.split('.')[1];
  const json = Buffer.from(payload, 'base64').toString('utf8');
  const decoded = JSON.parse(json);
  return decoded.exp ?? 0;
}

function parseTransformStatus(o: any): TransformStatus {
  const finishTimeRaw = o['finish-time'];
  return {
    requestId: o.request_id,
    title: o.title,
    status: o.status,
    submitTime: o['submit-time'] ? new Date(o['submit-time']) : undefined,
    finishTime: finishTimeRaw && finishTimeRaw !== 'None' ? new Date(finishTimeRaw) : undefined,
    files: o.files ?? 0,
    filesCompleted: o['files-completed'] ?? 0,
    filesFailed: o['files-failed'] ?? 0,
    selection: o.selection,
    did: o.did,
    resultFormat: o['result-format'],
  };
}

/**
 * Minimal port of servicex.servicex_adapter.ServiceXAdapter: refreshes a
 * bearer token from the configured refresh token, then uses it to fetch a
 * single transform's status the same way the Python CLI does.
 */
export class ServiceXApi {
  private accessToken?: string;
  private capabilities?: string[];

  constructor(private readonly endpoint: string, private readonly refreshToken?: string) {}

  private async ensureAccessToken(forceRefresh: boolean): Promise<string> {
    const now = Date.now() / 1000;
    if (this.accessToken && !forceRefresh) {
      if (decodeJwtExpiry(this.accessToken) - now > 60) {
        return this.accessToken;
      }
    }
    if (!this.refreshToken) {
      throw new Error('No refresh token configured for this ServiceX endpoint');
    }
    const res = await fetch(`${this.endpoint}/token/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.refreshToken}` },
    });
    if (!res.ok) {
      throw new Error(`ServiceX access token request rejected [${res.status}]`);
    }
    const body: any = await res.json();
    this.accessToken = body.access_token;
    return this.accessToken!;
  }

  private async getWithAuth(path: string): Promise<Response> {
    let token = await this.ensureAccessToken(false);
    let res = await fetch(`${this.endpoint}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Token may have just expired; refresh once and retry.
      token = await this.ensureAccessToken(true);
      res = await fetch(`${this.endpoint}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return res;
  }

  async getTransformStatus(requestId: string): Promise<TransformStatus> {
    const res = await this.getWithAuth(`/servicex/transformation/${requestId}`);
    if (res.status === 404) {
      throw new NotFoundError(`Transform ID ${requestId} not found`);
    }
    if (!res.ok) {
      throw new Error(`ServiceX WebAPI error ${res.status}`);
    }
    return parseTransformStatus(await res.json());
  }

  /**
   * Every transform visible to this token on this backend - mirrors
   * ServiceXAdapter.get_transforms in the Python client, which is what the
   * web dashboard itself calls to list "my" transforms. No id in the path
   * (unlike getTransformStatus), and the response wraps the same per-
   * transform shape in a "requests" array instead of returning one directly.
   */
  async getAllTransforms(): Promise<TransformStatus[]> {
    const res = await this.getWithAuth('/servicex/transformation');
    if (!res.ok) {
      throw new Error(`ServiceX WebAPI error ${res.status}`);
    }
    const body: any = await res.json();
    return (body.requests ?? []).map(parseTransformStatus);
  }

  /**
   * Cancels a running transform. Mirrors ServiceXAdapter.cancel_transform in
   * the Python client - a GET request, not a more RESTful POST/DELETE, since
   * that's the real shape of this endpoint on the backend.
   */
  async cancelTransform(requestId: string): Promise<void> {
    const res = await this.getWithAuth(`/servicex/transformation/${requestId}/cancel`);
    if (res.status === 404) {
      throw new NotFoundError(`Transform ID ${requestId} not found`);
    }
    if (!res.ok) {
      throw new Error(`ServiceX WebAPI error ${res.status}`);
    }
  }

  /**
   * The capability strings this backend advertises (e.g.
   * "poll_local_transformation_results") - mirrors
   * ServiceXAdapter.get_servicex_capabilities. Memoized per instance for the
   * same reason the Python client caches it: it's static for the lifetime of
   * a connection to one backend, so there's no reason to refetch it for every
   * row a caller happens to check.
   */
  private async getCapabilities(): Promise<string[]> {
    if (this.capabilities) {
      return this.capabilities;
    }
    const res = await this.getWithAuth('/servicex');
    if (!res.ok) {
      throw new Error(`ServiceX WebAPI error ${res.status}`);
    }
    const body: any = await res.json();
    this.capabilities = body.capabilities ?? [];
    return this.capabilities!;
  }

  /**
   * Total bytes produced so far for a transform, summed from its completed
   * result files - mirrors ServiceXAdapter.get_transformation_results, which
   * is what backs the "current size" the web dashboard shows for a transform
   * (running or finished). Not every backend supports this - it's gated
   * behind the "poll_local_transformation_results" capability - so this
   * returns undefined rather than throwing when that's missing, letting a
   * caller simply omit size instead of treating it as a hard failure.
   */
  async getTransformSize(requestId: string): Promise<number | undefined> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.includes('poll_local_transformation_results')) {
      return undefined;
    }
    const res = await this.getWithAuth(`/servicex/transformation/${requestId}/results`);
    if (!res.ok) {
      throw new Error(`ServiceX WebAPI error ${res.status}`);
    }
    const body: any = await res.json();
    const results: any[] = body.results ?? [];
    return results
      .filter((r) => r.transform_status === 'success')
      .reduce((sum, r) => sum + (r['total-bytes'] ?? 0), 0);
  }
}
