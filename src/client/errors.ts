export interface AlimailErrorBody {
  detailErrorCode?: string;
  message?: string;
  [k: string]: unknown;
}

export class AlimailApiError extends Error {
  readonly status: number;
  readonly detailErrorCode?: string;
  readonly requestId?: string;
  readonly hint?: string;
  readonly method: string;
  readonly path: string;

  constructor(opts: {
    status: number;
    method: string;
    path: string;
    body?: AlimailErrorBody;
    rawText?: string;
    requestId?: string;
  }) {
    const msg =
      opts.body?.message ??
      (opts.rawText ? opts.rawText.slice(0, 300) : `HTTP ${opts.status}`);
    super(msg);
    this.name = "AlimailApiError";
    this.status = opts.status;
    this.method = opts.method;
    this.path = opts.path;
    this.detailErrorCode = opts.body?.detailErrorCode;
    this.requestId = opts.requestId;
    this.hint = hintFor(opts.status);
  }

  toJSON() {
    return {
      error: "AlimailApiError",
      status: this.status,
      detailErrorCode: this.detailErrorCode,
      message: this.message,
      requestId: this.requestId,
      request: `${this.method} ${this.path}`,
      hint: this.hint,
    };
  }
}

export class AlimailNetworkError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "AlimailNetworkError";
  }
  toJSON() {
    return {
      error: "AlimailNetworkError",
      message: this.message,
      request: `${this.method} ${this.path}`,
      hint: "检查网络连通性与 ALIMAIL_API_BASE 是否为企业所在集群的地址。",
    };
  }
}

function hintFor(status: number): string | undefined {
  switch (status) {
    case 400:
      return "请求参数不合法，请根据 detailErrorCode / message 修正参数。";
    case 401:
      return "授权失败：检查 ALIMAIL_CLIENT_ID / ALIMAIL_CLIENT_SECRET 是否正确、应用是否启用。";
    case 403:
      return "应用缺少该接口的 API 权限（Scope），请在阿里邮箱域管后台的应用管理页面补充授权。";
    case 404:
      return "资源不存在：确认用户邮箱 / ID 或部门 ID 是否正确。";
    case 409:
      return "资源冲突（例如邮箱地址已存在）。";
    case 412:
      return "前置条件不满足（例如删除非空部门）。";
    case 429:
      return "触发限流（单域所有应用合计 40 次/秒），请稍后重试或降低 ALIMAIL_MAX_QPS。";
    default:
      return status >= 500 ? "阿里邮箱服务端错误，请稍后重试。" : undefined;
  }
}
