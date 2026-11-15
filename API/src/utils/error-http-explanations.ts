export type PublicExplanation = {
  summary: string;
  details?: string[];
  hints?: string[];
};


export function defaultHttpErrorExplanation(statusCode: number): PublicExplanation {
  if (statusCode === 400) {
    return {
      summary: 'The request could not be processed because one or more inputs were invalid.',
      hints: ['Check required fields, field names, and allowed values.'],
    };
  }

  if (statusCode === 401) {
    return {
      summary: 'Authentication is required or the supplied credentials were not accepted.',
      hints: ['Check the supplied tokens, credentials, and auth preconditions for this route.'],
    };
  }

  if (statusCode === 403) {
    return {
      summary:
        'The request was understood, but the current identity does not have permission to perform it.',
      hints: ['Check the caller role, domain scope, and access token claims.'],
    };
  }

  if (statusCode === 404) {
    return {
      summary: 'The requested route or resource was not found.',
      hints: ['Check the URL path, identifiers, and whether the target exists.'],
    };
  }

  return {
    summary: 'The server hit an unexpected error while handling this request.',
    hints: ['Check the server logs for the full error and stack trace.'],
  };
}
