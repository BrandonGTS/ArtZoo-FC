import type { Instrumentation } from 'next';
import { logUnexpectedHttpError } from './server/http-error-log';

// Do not forward request/context: paths, headers and error text can contain secrets.
// Keep the same four-field classification whitelist as HTTP adapter failures.
export const onRequestError: Instrumentation.onRequestError = (error) => {
  logUnexpectedHttpError(error, 'next/request');
};
