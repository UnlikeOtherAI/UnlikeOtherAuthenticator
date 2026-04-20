import { domainToASCII } from 'node:url';

export function extractEmailDomain(email: string): string | null {
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0 || atIndex === email.length - 1) return null;

  const asciiDomain = domainToASCII(
    email
      .slice(atIndex + 1)
      .trim()
      .replace(/\.$/, ''),
  );
  return asciiDomain ? asciiDomain.toLowerCase() : null;
}
