export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

export function emailDomain(email: string): string | undefined {
  const i = email.lastIndexOf("@");
  return i > 0 ? email.slice(i + 1).toLowerCase() : undefined;
}

export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

/** Enforces ALIMAIL_ALLOWED_DOMAINS (exact domain or subdomain match). Empty list = unrestricted. */
export class DomainScope {
  constructor(private readonly allowed: string[]) {}

  get restricted(): boolean {
    return this.allowed.length > 0;
  }

  isAllowed(email: string): boolean {
    if (!this.restricted) return true;
    const d = emailDomain(email);
    if (!d) return false;
    return this.allowed.some((a) => d === a || d.endsWith("." + a));
  }

  assertEmail(email: string, what = "邮箱地址"): void {
    if (!this.isAllowed(email)) {
      throw new ScopeError(
        `${what} ${email} 不在允许的域名范围内（ALIMAIL_ALLOWED_DOMAINS=${this.allowed.join(",")}）`,
      );
    }
  }

  assertDomain(domain: string, what = "域名"): void {
    if (!this.isAllowed(`_@${domain}`)) {
      throw new ScopeError(
        `${what} ${domain} 不在允许的域名范围内（ALIMAIL_ALLOWED_DOMAINS=${this.allowed.join(",")}）`,
      );
    }
  }
}
