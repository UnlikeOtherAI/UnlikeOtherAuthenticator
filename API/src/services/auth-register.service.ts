import type { ClientConfig } from './config.service.js';

/**
 * Brief 11: Registration must not reveal whether the email exists.
 *
 * Task 4.3 implements the endpoint + constant response behavior.
 * Task 4.4 will implement "email determines next step" (existing -> login link,
 * new -> verification + set password) without changing the public response.
 */
export async function requestRegistrationInstructions(_params: {
  email: string;
  config: ClientConfig;
}): Promise<void> {
  // Intentionally a no-op for now. Email delivery and token flows are implemented in later tasks.
  void _params;
}
