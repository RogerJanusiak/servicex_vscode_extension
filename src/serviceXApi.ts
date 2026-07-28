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
  };
}

/**
 * Minimal port of servicex.servicex_adapter.ServiceXAdapter: refreshes a
 * bearer token from the configured refresh token, then uses it to fetch a
 * single transform's status the same way the Python CLI does.
 */
export class ServiceXApi {
  private accessToken?: string;

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
}
