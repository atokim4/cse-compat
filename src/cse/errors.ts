/**
 * Google API error bodies, byte-compatible with what customsearch.googleapis.com returns.
 *
 * Shapes were captured from the live service (no key, bad key, alt=xml) and from error texts quoted
 * in public bug reports (invalid cx, paging past 100, daily quota). Clients such as googleapiclient
 * read `error.message` and `error.errors[0].reason`, so both are always present.
 */

const SERVICE = "customsearch.googleapis.com";

export type GoogleStatus =
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "RESOURCE_EXHAUSTED"
  | "NOT_FOUND"
  | "INTERNAL"
  | "UNAVAILABLE";

type ErrorDetail =
  | {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo";
      reason: string;
      domain: "googleapis.com";
      metadata: Record<string, string>;
    }
  | { "@type": "type.googleapis.com/google.rpc.LocalizedMessage"; locale: "en-US"; message: string };

export interface GoogleErrorBody {
  error: {
    code: number;
    message: string;
    errors: { message: string; domain: "global"; reason: string }[];
    status: GoogleStatus;
    details?: ErrorDetail[];
  };
}

export class GoogleApiError extends Error {
  constructor(
    readonly code: 400 | 403 | 404 | 429 | 500 | 503,
    readonly status: GoogleStatus,
    readonly reason: string,
    message: string,
    readonly errorInfoReason?: string,
    readonly metadata: Record<string, string> = {},
  ) {
    super(message);
    this.name = "GoogleApiError";
  }

  toBody(): GoogleErrorBody {
    const body: GoogleErrorBody = {
      error: {
        code: this.code,
        message: this.message,
        errors: [{ message: this.message, domain: "global", reason: this.reason }],
        status: this.status,
      },
    };
    if (this.errorInfoReason !== undefined) {
      body.error.details = [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: this.errorInfoReason,
          domain: "googleapis.com",
          metadata: { service: SERVICE, ...this.metadata },
        },
        { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message: this.message },
      ];
    }
    return body;
  }
}

/** Google's generic text for a bad cx, a bad parameter value or a page past result 100. */
export const INVALID_ARGUMENT_MESSAGE = "Request contains an invalid argument.";

export const errors = {
  invalidArgument: (message: string = INVALID_ARGUMENT_MESSAGE) =>
    new GoogleApiError(400, "INVALID_ARGUMENT", "badRequest", message),

  invalidSystemParam: (name: string, value: string) =>
    new GoogleApiError(400, "INVALID_ARGUMENT", "badRequest", `Invalid value "${value}" for query parameter '${name}'`),

  missingKey: () =>
    new GoogleApiError(403, "PERMISSION_DENIED", "forbidden", "Permission denied on the service.", "ACCESS_DENIED"),

  invalidKey: () =>
    new GoogleApiError(
      400,
      "INVALID_ARGUMENT",
      "badRequest",
      "API key not valid. Please pass a valid API key.",
      "API_KEY_INVALID",
    ),

  dailyQuota: (limit: number) =>
    new GoogleApiError(
      429,
      "RESOURCE_EXHAUSTED",
      "rateLimitExceeded",
      `Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service '${SERVICE}'.`,
      "RATE_LIMIT_EXCEEDED",
      { quota_metric: `${SERVICE}/default`, quota_limit: "Queries per day", quota_limit_value: String(limit) },
    ),

  /** The search backend's own plan quota is used up. Same shape as the daily quota error, without a limit value. */
  backendQuota: () =>
    new GoogleApiError(
      429,
      "RESOURCE_EXHAUSTED",
      "rateLimitExceeded",
      "Quota exceeded for the search backend of this server. Try again later.",
      "RATE_LIMIT_EXCEEDED",
    ),

  notFound: () => new GoogleApiError(404, "NOT_FOUND", "notFound", "Requested entity was not found."),

  backendUnavailable: () =>
    new GoogleApiError(503, "UNAVAILABLE", "backendError", "The service is currently unavailable."),

  internal: () => new GoogleApiError(500, "INTERNAL", "backendError", "Internal error encountered."),
} as const;
